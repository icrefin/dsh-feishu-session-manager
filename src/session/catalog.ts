/**
 * The picture of the installation the routing model sees.
 *
 * One catalog read answers: which workspaces exist, which sessions live in each,
 * how fresh each session is, how much of its context budget it has spent, and
 * the last few lines of what it was working on. That is exactly the information
 * the routing prompt needs, and nothing else from the session log.
 *
 * Reads go through `ctx.sessionQuery`, which prefers live sessions and reads
 * persisted copies for everything else, so a session whose Agent is cold still
 * contributes a digest. Digests are cached briefly: a chat burst (three messages
 * in ten seconds) must not re-read twelve surfaces three times.
 *
 * @module dsh-feishu-session-manager/session/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: these put `sessionQuery`, `workspaceRegistry`,
// `sessionProjections` and `agents` on Context, and declare their value shapes.
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import {
  digestFromEvents,
  estimateTokens,
  lastUserText,
  renderDigest,
  surfaceChars,
  type DigestEntry,
  type SurfaceEventLike,
} from './extract.ts'

/** One workspace as the router needs to see it. */
export interface WorkspaceView {
  /** Registry identity. */
  readonly id: string
  /** Display title. */
  readonly title: string
  /** Absolute directory. */
  readonly path: string
  /** Session ids grouped under it. */
  readonly sessionIds: readonly string[]
}

/** One candidate session as the router needs to see it. */
export interface SessionView {
  readonly id: string
  /** Title, or the newest user prompt when the session has none yet. */
  readonly title: string
  /** Working directory recorded on the header. */
  readonly cwd: string
  /** Workspace that owns the session, when one does. */
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  /** Last activity, epoch milliseconds; header creation time when the log is empty. */
  readonly updatedAt: number
  /** Whole minutes since `updatedAt`. */
  readonly inactiveMinutes: number
  /** Whether a live Agent currently works this session. */
  readonly running: boolean
  /** Whether the session is blocked on a human answer. */
  readonly waiting: boolean
  /** Estimated (or measured) prompt size of the next request. */
  readonly contextTokens: number
  /**
   * The model's own context capacity for this session, when the Harness knows it.
   *
   * This is the window the session actually runs under — reported by the route
   * that last served it, or resolved from the session's selected model — never a
   * budget invented by this plugin. `0` means "unknown", and then the router is
   * told nothing about pressure rather than something wrong.
   */
  readonly contextWindow: number
  /** `contextTokens` as a percentage of {@link contextWindow}; `0` when unknown. */
  readonly contextPercent: number
  /** Transcript lines kept for the prompt. */
  readonly digest: readonly DigestEntry[]
  /** Digest rendered to one bounded block. */
  readonly digestText: string
  /** Newest user prompt, for a title fallback. */
  readonly lastUserText: string
}

/** One consistent catalog read. */
export interface Catalog {
  /** Epoch milliseconds of the read. */
  readonly readAt: number
  readonly workspaces: readonly WorkspaceView[]
  readonly sessions: readonly SessionView[]
}

/** What one catalog read needs from the settings. */
export interface CatalogOptions {
  /** Maximum candidate sessions. */
  readonly maxSessions: number
  /** Characters of transcript kept per session. */
  readonly historyChars: number

  /** Sessions blocked on an interaction this plugin itself tracks. */
  readonly pending?: ReadonlySet<string>
}

/** How long one session digest stays usable, in milliseconds. */
const DIGEST_TTL = 15000

/** How many extra candidates are read before the recency cut, so ranking is honest. */
const OVERSAMPLE = 3

/** One cached digest. */
interface CachedDigest {
  readonly at: number
  readonly updatedAt: number
  readonly digest: readonly DigestEntry[]
  readonly digestText: string
  readonly chars: number
  readonly lastUserText: string
}

/** Process-local digest cache, keyed by session id. */
const digestCache = new Map<string, CachedDigest>()

/**
 * Build the catalog.
 *
 * Candidate selection is two-pass on purpose. The stored record carries only the
 * creation time, while the routing decision needs last-activity time, which lives
 * in the log. So the first pass oversamples by creation time, each digest read
 * reports its own newest event time, and the second pass sorts by that and keeps
 * `maxSessions`. The oversampled digests stay in the cache, so the next message
 * pays for roughly one read per newly active session.
 *
 * @param ctx - host context carrying the query, workspace and projection services.
 * @param options - bounds from the row config.
 * @param signal - cancellation for the reads.
 * @returns the workspaces and candidate sessions, newest first.
 */
export async function readCatalog(ctx: Context, options: CatalogOptions, signal?: AbortSignal): Promise<Catalog> {
  const readAt = Date.now()
  const workspaces = readWorkspaces(ctx)
  const records = await ctx.sessionQuery.listSessions(signal)
  const archived = new Set<string>(ctx.workspaceRegistry.archivedSessionIds.map(String))
  const pending = new Set<string>(options.pending ?? [])

  const routable = records
    .filter((record) => isRoutable(record, archived))
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
    .slice(0, Math.max(1, Math.floor(options.maxSessions)) * OVERSAMPLE)

  const ids = routable.map((record) => String(record.header.id))
  const titles = await readTitles(ctx, ids, signal)
  const read: SessionView[] = []
  for (const record of routable) {
    signal?.throwIfAborted()
    const id = String(record.header.id)
    const digest = await readDigest(ctx, id, options.historyChars)
    const workspace = workspaceFor(workspaces, id, record.header.cwd)
    const updatedAt = digest.updatedAt > 0 ? digest.updatedAt : record.header.createdAt
    const contextTokens = contextTokensOf(ctx, id, digest.chars)
    const contextWindow = await contextWindowOf(ctx, id)
    read.push({
      id,
      title: titles.get(id) ?? (digest.lastUserText === '' ? 'untitled' : truncate(digest.lastUserText, 60)),
      cwd: record.header.cwd ?? '',
      workspaceId: workspace?.id ?? '',
      workspaceTitle: workspace?.title ?? (record.header.cwd === undefined ? '' : basename(record.header.cwd)),
      workspacePath: workspace?.path ?? (record.header.cwd ?? ''),
      updatedAt,
      inactiveMinutes: Math.max(0, Math.round((readAt - updatedAt) / 60000)),
      running: runningOf(ctx, id),
      waiting: pending.has(id) || hasPendingQuestion(ctx, id),
      contextTokens,
      contextWindow,
      contextPercent: contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0,
      digest: digest.digest,
      digestText: digest.digestText,
      lastUserText: digest.lastUserText,
    })
  }
  read.sort((left, right) => right.updatedAt - left.updatedAt)
  const sessions = read.slice(0, Math.max(1, Math.floor(options.maxSessions)))
  return { readAt, workspaces, sessions }
}

/**
 * Read every workspace.
 * @param ctx - host context.
 * @returns workspace views in registry order.
 */
function readWorkspaces(ctx: Context): WorkspaceView[] {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
  return registry.list().map((workspace) => ({
    id: String(workspace.id),
    title: typeof workspace.title === 'string' ? workspace.title : String(workspace.id),
    path: typeof workspace.path === 'string' ? workspace.path : '',
    sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
  }))
}

/**
 * Find the workspace that owns a session.
 * @param workspaces - workspace views.
 * @param sessionId - session id.
 * @param cwd - session working directory, when recorded.
 * @returns the owning workspace, or `undefined`.
 */
function workspaceFor(
  workspaces: readonly WorkspaceView[],
  sessionId: string,
  cwd: string | undefined,
): WorkspaceView | undefined {
  const byMembership = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))
  if (byMembership !== undefined) return byMembership
  if (cwd === undefined) return undefined
  return workspaces.find((workspace) => workspace.path === cwd)
}

/**
 * Decide whether a stored session can be routed to.
 * @param record - one logical-corpus record.
 * @param archived - archived session ids.
 * @returns true when the session is an ordinary, unarchived session.
 */
function isRoutable(
  record: {
    readonly header: { readonly id: unknown; readonly origin?: string; readonly delegationDepth?: number }
  },
  archived: ReadonlySet<string>,
): boolean {
  if (record.header.origin === 'subagent') return false
  if ((record.header.delegationDepth ?? 0) > 0) return false
  return !archived.has(String(record.header.id))
}

/**
 * Whether the session's live Agent is working right now.
 * @param ctx - host context.
 * @param sessionId - session id.
 * @returns true while the agent runs.
 */
function runningOf(ctx: Context, sessionId: string): boolean {
  const agents = ctx.get('agents')
  if (agents === undefined) return false
  const agent = agents.get(sessionId as never)
  return agent !== undefined && agent.status === 'running'
}

/**
 * Whether the session has an unanswered `ask_user_question` call.
 * @param ctx - host context.
 * @param sessionId - session id.
 * @returns true when the question projection lists an active call.
 */
function hasPendingQuestion(ctx: Context, sessionId: string): boolean {
  const projections = ctx.get('sessionProjections')
  const sessions = ctx.get('sessions')
  if (projections === undefined || sessions === undefined) return false
  const session = sessions.get(sessionId as never)
  if (session === undefined) return false
  try {
    const state = projections.stateOf(session, 'userQuestions') as { active?: readonly unknown[] } | undefined
    return Array.isArray(state?.active) && state.active.length > 0
  } catch {
    return false
  }
}

/**
 * Read the latest title of each session.
 * @param ctx - host context.
 * @param ids - session ids.
 * @param signal - cancellation.
 * @returns id → title, missing entries omitted.
 */
async function readTitles(ctx: Context, ids: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (ids.length === 0) return titles
  try {
    const observations = await ctx.sessionQuery.readTitleSnapshots(ids as never[], signal)
    for (const observation of observations) {
      if (observation.status !== 'fulfilled') continue
      const snapshot = (observation.value as { title?: { title?: unknown } }).title
      const title = snapshot?.title
      if (typeof title === 'string' && title.trim() !== '') titles.set(String(observation.sessionId), title.trim())
    }
  } catch {
    // A title is a convenience; a failure here must not fail the routing read.
  }
  return titles
}

/**
 * Read one session's digest, cached briefly.
 * @param ctx - host context.
 * @param sessionId - session id.
 * @param historyChars - character budget for the rendered digest.
 * @returns the digest, its surface size and its newest event time.
 */
async function readDigest(ctx: Context, sessionId: string, historyChars: number): Promise<CachedDigest> {
  const cached = digestCache.get(sessionId)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < DIGEST_TTL) return cached
  let events: readonly SurfaceEventLike[] = []
  try {
    const snapshot = await ctx.sessionQuery.readSurface(sessionId as never)
    events = snapshot.events as unknown as readonly SurfaceEventLike[]
  } catch {
    events = []
  }
  let updatedAt = 0
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > updatedAt) updatedAt = event.time
  }
  const digest = digestFromEvents(events)
  const record: CachedDigest = {
    at: now,
    updatedAt,
    digest,
    digestText: renderDigest(digest, historyChars),
    chars: surfaceChars(events),
    lastUserText: lastUserText(digest),
  }
  digestCache.set(sessionId, record)
  if (digestCache.size > 128) {
    const oldest = digestCache.keys().next()
    if (oldest.done !== true) digestCache.delete(oldest.value)
  }
  return record
}

/**
 * Prompt size of the next request, measured when possible.
 * @param ctx - host context.
 * @param sessionId - session id.
 * @param chars - surface characters, for the estimate fallback.
 * @returns estimated tokens.
 */
function contextTokensOf(ctx: Context, sessionId: string, chars: number): number {
  const projections = ctx.get('sessionProjections')
  const sessions = ctx.get('sessions')
  if (projections !== undefined && sessions !== undefined) {
    const session = sessions.get(sessionId as never)
    if (session !== undefined) {
      try {
        const state = projections.stateOf(session, 'contextPressure') as
          | { projectedTokens?: number; pressureTokens?: number }
          | undefined
        const measured = state?.projectedTokens ?? state?.pressureTokens
        if (typeof measured === 'number' && measured > 0) return Math.round(measured)
      } catch {
        // Fall through to the estimate.
      }
    }
  }
  return estimateTokens(chars)
}

/** Model windows this process already resolved, keyed by `provider/model`. */
const windowCache = new Map<string, number>()

/** The deployment default's window, keyed by the default route and time-resolved. */
const defaultWindows = new Map<string, { readonly at: number; readonly value: number }>()

/** How long the deployment default window stays usable. */
const DEFAULT_WINDOW_TTL = 60000

/**
 * Resolve the model capacity one session actually runs under.
 *
 * Three sources, strongest first:
 * 1. the `contextPressure` projection, whose `contextWindow` is the capacity the
 *    route reported for the session's newest request — the real thing;
 * 2. the session's durable model selection, resolved through the LLM service;
 * 3. the deployment default model, for a cold session whose own selection is not
 *    readable without replaying its log.
 *
 * A session whose window cannot be established reports `0`, and the router is told
 * that pressure is unknown instead of being handed a made-up number.
 *
 * @param ctx - host context carrying projections, the LLM service and the controller.
 * @param sessionId - session id.
 * @returns the native context window in tokens, or `0`.
 */
async function contextWindowOf(ctx: Context, sessionId: string): Promise<number> {
  const projections = ctx.get('sessionProjections')
  const sessions = ctx.get('sessions')
  const live = projections !== undefined && sessions !== undefined ? sessions.get(sessionId as never) : undefined
  if (projections !== undefined && live !== undefined) {
    try {
      const pressure = projections.stateOf(live, 'contextPressure') as { contextWindow?: unknown } | undefined
      const window = pressure?.contextWindow
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) return Math.round(window)
    } catch {
      // Fall through to the selection.
    }
    try {
      const selection = projections.stateOf(live, 'modelSelection') as
        | { next?: { provider?: string; model?: string } | null; lastUsed?: { provider?: string; model?: string } | null }
        | undefined
      const chosen = selection?.next ?? selection?.lastUsed
      const resolved = await resolveWindow(ctx, chosen?.provider, chosen?.model)
      if (resolved > 0) return resolved
    } catch {
      // Fall through to the deployment default.
    }
  }
  try {
    const catalog = await ctx.sessionController.modelCatalog()
    const provider = catalog.default?.provider
    const model = catalog.default?.model
    if (provider === undefined || model === undefined) return 0
    const route = `${provider}/${model}`
    const now = Date.now()
    const cached = defaultWindows.get(route)
    if (cached !== undefined && now - cached.at < DEFAULT_WINDOW_TTL) return cached.value
    const value = await resolveWindow(ctx, provider, model)
    defaultWindows.set(route, { at: now, value })
    return value
  } catch {
    return 0
  }
}

/**
 * Resolve one model route's context window through the LLM service.
 * @param ctx - host context.
 * @param provider - provider route.
 * @param model - model id.
 * @returns the window, or `0` when the route cannot be resolved.
 */
async function resolveWindow(ctx: Context, provider: string | undefined, model: string | undefined): Promise<number> {
  if (provider === undefined || model === undefined || provider === '' || model === '') return 0
  const key = `${provider}/${model}`
  const cached = windowCache.get(key)
  if (cached !== undefined) return cached
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    const window = (info as { contextWindow?: unknown }).contextWindow
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      windowCache.set(key, Math.round(window))
      return Math.round(window)
    }
  } catch {
    return 0
  }
  return 0
}

/**
 * Last path segment.
 * @param path - absolute path.
 * @returns the final segment, or the path itself.
 */
function basename(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? path : (parts[parts.length - 1] ?? path)
}

/**
 * Clip text to a budget, appending an ellipsis.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns the clipped text.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}