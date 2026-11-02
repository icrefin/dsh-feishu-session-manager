/**
 * The deterministic route used when the model answer is unusable.
 *
 * A routing failure must not become a dead end. The human already said what they
 * want; the plugin can still act on it, and say which guess it made. This module
 * holds that guess as a pure function so it can be tested and reviewed without a
 * model, and so the failure path has exactly one definition.
 *
 * The rule is deliberately conservative: start new work in the workspace the
 * human is most likely in, rather than re-open a session on a guess. Continuing
 * the wrong session costs the user a confusing turn; starting a fresh session in
 * a named workspace costs one line of text they can correct with `/use`.
 *
 * @module dsh-feishu-session-manager/llm/fallback
 */

import type { Catalog, SessionView, WorkspaceView } from '../session/catalog.ts'
import type { RouteDecision } from '../protocol.ts'

/** Inputs the fallback needs beyond the catalog. */
export interface FallbackInput {
  /** The human's message, delivered verbatim when a session is created. */
  readonly message: string
  /** Whether creating a session is allowed at all. */
  readonly allowNewSession: boolean
}

/** Shortest workspace token worth matching against a message. */
const MIN_TOKEN = 3

/**
 * Pick the route to use when the model produced nothing usable.
 *
 * Order of preference:
 * 1. a workspace the message actually names (title or final path segment);
 * 2. the workspace of the most recently active session;
 * 3. when creating sessions is disabled, the most recently active session;
 * 4. otherwise ask the human, because there is nothing to route to.
 *
 * @param catalog - the catalog the model was shown.
 * @param input - message and policy.
 * @returns a validated decision the bridge can execute as-is.
 */
export function chooseFallbackRoute(catalog: Catalog, input: FallbackInput): RouteDecision {
  const message = input.message.trim()
  const recent = mostRecent(catalog.sessions)
  const named = workspaceNamedIn(catalog.workspaces, message)
  const workspace = named ?? workspaceOf(catalog, recent)

  if (input.allowNewSession && workspace !== undefined) {
    return {
      action: 'new_session',
      workspaceId: workspace.id,
      prompt: message === '' ? 'Continue.' : message,
      reason: `routing model answer unusable; new session in ${workspace.title}`,
      confidence: 0,
    }
  }
  if (recent !== undefined && recent.id !== '') {
    return {
      action: 'continue',
      sessionId: recent.id,
      prompt: message === '' ? 'Continue.' : message,
      reason: `routing model answer unusable; continued the most recent session (${recent.title})`,
      confidence: 0,
    }
  }
  return {
    action: 'reply',
    prompt: '',
    reply:
      'The routing model did not answer in a usable form, and there is no session or workspace to fall back to. '
      + 'Send /sessions to see what exists, or /new to create a session.',
    reason: 'routing model answer unusable; nothing to fall back to',
    confidence: 0,
  }
}

/**
 * The session with the newest activity.
 * @param sessions - catalog sessions.
 * @returns the newest session, or `undefined`.
 */
function mostRecent(sessions: readonly SessionView[]): SessionView | undefined {
  let best: SessionView | undefined
  for (const session of sessions) {
    if (best === undefined || session.updatedAt > best.updatedAt) best = session
  }
  return best
}

/**
 * The workspace that owns a session.
 * @param catalog - catalog to search.
 * @param session - session to find.
 * @returns the owning workspace, or `undefined`.
 */
function workspaceOf(catalog: Catalog, session: SessionView | undefined): WorkspaceView | undefined {
  if (session === undefined) return undefined
  return (
    catalog.workspaces.find((workspace) => workspace.id === session.workspaceId) ??
    catalog.workspaces.find((workspace) => workspace.path !== '' && workspace.path === session.workspacePath)
  )
}

/**
 * Find a workspace the message names.
 * @param workspaces - workspaces to test.
 * @param message - the human's message.
 * @returns the first workspace whose title or final path segment appears.
 */
function workspaceNamedIn(workspaces: readonly WorkspaceView[], message: string): WorkspaceView | undefined {
  const haystack = message.toLowerCase()
  for (const workspace of workspaces) {
    const candidates = [workspace.title, lastSegment(workspace.path)].filter((value) => value.length >= MIN_TOKEN)
    for (const candidate of candidates) {
      if (haystack.includes(candidate.toLowerCase())) return workspace
    }
  }
  return undefined
}

/**
 * Final segment of a path.
 * @param path - absolute path.
 * @returns the segment, or `''`.
 */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? '' : (parts[parts.length - 1] ?? '')
}