/**
 * Prompt construction and answer parsing for the two model calls.
 *
 * Both calls are one-shot and stateless: the plugin renders one bounded user
 * message, the model answers, and the plugin validates the answer before acting
 * on it. Keeping the rendering and the parsing pure is what makes the risky part
 * — trusting a model with a routing decision — testable without a model.
 *
 * The router sees a compact JSON catalog rather than prose, because JSON keeps
 * ids unambiguous and costs fewer tokens than narrating the same facts.
 *
 * @module dsh-feishu-session-manager/llm/prompts
 */

import type { Catalog, SessionView, WorkspaceView } from '../session/catalog.ts'
import type { RouteDecision, RouteAction } from '../protocol.ts'

/** Identity a summary must carry. */
export interface SummaryIdentity {
  readonly workspace: string
  readonly workspacePath: string
  readonly session: string
  readonly sessionId: string
}

/** One summary request. */
export interface SummaryInput {
  readonly identity: SummaryIdentity
  readonly event: 'turn-finished' | 'turn-failed'
  readonly failureCode?: string
  /** Transcript block, already bounded. */
  readonly transcript: string
  /** Free-form note, such as the turn's stop reason. */
  readonly note?: string
}

/** The actions a parsed decision may carry. */
const ACTIONS: readonly RouteAction[] = ['continue', 'new_session', 'new_session_with_context', 'reply', 'ignore']

/** The answer contract, repeated inside the user message.
 *
 * The system prompt states it too, but a hand-built one-shot request can reach an
 * adapter that drops or truncates the system slot, and a model that never saw the
 * contract answers in prose. Restating it here costs about forty tokens and makes
 * the request self-sufficient.
 */
const ANSWER_CONTRACT =
  'Reply with ONE JSON object and nothing else. No prose, no code fence, no reasoning.\n' +
  '{"action":"continue|new_session|new_session_with_context|reply|ignore",' +
  '"sessionId":"<existing session id>","workspaceId":"<workspace id>",' +
  '"prompt":"<text for the target session>","context":"<facts to carry over>",' +
  '"reply":"<short message to the human>","reason":"<one sentence>","confidence":0.0}'

/**
 * Render the routing user message.
 *
 * @param catalog - workspaces and candidate sessions.
 * @param message - the human's inbound text.
 * @param now - current epoch milliseconds, rendered as ISO.
 * @param strict - repeat the answer contract inline (the retry attempt).
 * @returns one JSON document, as text.
 */
export function buildRouteUserMessage(
  catalog: Catalog,
  message: string,
  now: number,
  strict = false,
): string {
  const workspaces = catalog.workspaces.map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
  }))
  const sessions = catalog.sessions.map((session) => compactSession(session))
  const body = JSON.stringify(
    {
      now: new Date(now).toISOString(),
      workspaces,
      sessions,
      message,
    },
    null,
    1,
  )
  return strict ? `${body}\n\n${ANSWER_CONTRACT}` : body
}

/**
 * One session as the routing prompt shows it.
 * @param session - catalog entry.
 * @returns the compact record.
 */
function compactSession(session: SessionView): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    workspaceId: session.workspaceId,
    workspace: session.workspaceTitle,
    inactiveMinutes: session.inactiveMinutes,
    running: session.running,
    waiting: session.waiting,
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow > 0 ? session.contextWindow : null,
    contextPercent: session.contextWindow > 0 ? session.contextPercent : null,
    transcript: session.digestText,
  }
}

/**
 * Render the summary user message.
 * @param input - identity, event and bounded transcript.
 * @returns one JSON document, as text.
 */
export function buildSummaryUserMessage(input: SummaryInput): string {
  return JSON.stringify(
    {
      workspace: input.identity.workspace,
      workspacePath: input.identity.workspacePath,
      session: input.identity.session,
      sessionId: input.identity.sessionId,
      event: input.event,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      ...(input.note === undefined ? {} : { note: input.note }),
      transcript: input.transcript,
    },
    null,
    1,
  )
}

/**
 * Append a language directive to a system prompt.
 * @param prompt - the user-editable policy text.
 * @param language - `auto`, `en` or `zh`.
 * @returns the prompt with the directive appended when one applies.
 */
export function withLanguageDirective(prompt: string, language: string): string {
  if (language === 'en') return `${prompt}\n\nAlways answer in English.`
  if (language === 'zh') return `${prompt}\n\n请始终使用简体中文回答。`
  return `${prompt}\n\nAnswer in the same language as the human's message.`
}

/**
 * Normalize a summarizer answer so it always identifies its session.
 *
 * The first line is mandated by the prompt, but a model that ignores it would
 * leave the human unable to tell which session the push came from. So a leading
 * identity-ish line is replaced by the deterministic one, and a body without any
 * identity gets the deterministic line prepended.
 *
 * @param body - raw model text.
 * @param identity - workspace and session names.
 * @returns the message body, always starting with the identity line.
 */
export function normalizeSummary(body: string, identity: SummaryIdentity): string {
  const lines = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
  while (lines.length > 0) {
    const first = (lines[0] ?? '').trim()
    if (first === '') {
      lines.shift()
      continue
    }
    if (/^(workspace|工作区|会话|session)\s*[:：]/i.test(first) || /Workspace:.*Session:/i.test(first)) {
      lines.shift()
      continue
    }
    break
  }
  const header = `Workspace: ${identity.workspace} | Session: ${identity.session}`
  const rest = lines.join('\n').trim()
  return rest === '' ? header : `${header}\n${rest}`
}

/**
 * Close a truncated JSON object.
 *
 * A reasoning model whose output budget runs out stops mid-object, and the
 * fragment is still usable: every field written before the cut is valid. This
 * closes the open string, array and object in reverse order and drops a trailing
 * comma or a dangling key, so the prefix parses.
 *
 * @param fragment - text starting at an opening brace.
 * @returns a reparably closed object, or `''` when nothing can be closed.
 */
export function repairJsonObject(fragment: string): string {
  let text = fragment.trim()
  if (text.startsWith('{') === false) return ''
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') stack.pop()
  }
  if (inString) text += '"'
  // A cut between two pairs leaves a trailing comma or a bare key.
  text = text.replace(/,\s*$/, '')
  text = text.replace(/,\s*"[^"]*"\s*:\s*$/, '')
  text = text.replace(/,\s*"[^"]*"\s*$/, '')
  for (let index = stack.length - 1; index >= 0; index -= 1) text += stack[index]
  return text
}

/**
 * Pull one JSON object out of a model answer.
 *
 * Models wrap JSON in fences, prepend "Here is the JSON", or — when the output
 * budget runs out — stop mid-object. This accepts fenced bodies, bare objects,
 * an object embedded in prose, and a truncated tail that can be closed, and
 * refuses anything that still does not parse.
 *
 * @param raw - model text.
 * @returns the parsed value, or `null`.
 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim()
  if (text === '') return null
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence !== null && fence[1] !== undefined) candidates.push(fence[1].trim())
  candidates.push(text)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  if (start >= 0) candidates.push(repairJsonObject(text.slice(start)))
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Recover the fields of a decision from text that is not valid JSON at all.
 *
 * Last resort for a model that ignored the contract: the fields are still usually
 * present as `"action": "..."` pairs. Only values that pass the same validation
 * as a parsed answer are used, so this widens parsing without widening trust.
 *
 * @param raw - model text.
 * @returns a partial record with whatever could be read.
 */
export function salvageDecision(raw: string): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  const read = (key: string): string | undefined => {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)
    if (match === null || match[1] === undefined) return undefined
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1]
    }
  }
  const action = read('action')
  if (action !== undefined) record.action = action
  for (const key of ['sessionId', 'workspaceId', 'prompt', 'context', 'reply', 'reason']) {
    const value = read(key)
    if (value !== undefined) record[key] = value
  }
  const confidence = /"confidence"\s*:\s*([0-9.]+)/.exec(raw)
  if (confidence?.[1] !== undefined) record.confidence = Number(confidence[1])
  return record
}

/**
 * Read one decision value from parsed JSON or, failing that, from raw text.
 * @param raw - model text.
 * @param parsed - result of {@link extractJsonObject}, when it parsed.
 * @returns the record to validate, or `null` when nothing could be read.
 */
function decisionRecord(raw: string, parsed: unknown): Record<string, unknown> | null {
  if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
  const salvaged = salvageDecision(raw)
  return typeof salvaged.action === 'string' ? salvaged : null
}

/** Identity sets a decision is validated against. */
export interface DecisionContext {
  readonly sessionIds: ReadonlySet<string>
  readonly workspaceIds: ReadonlySet<string>
  /** Inbound text, used as the delivery fallback when the model drops `prompt`. */
  readonly message: string
  /** Whether the deployment allows creating sessions from chat. */
  readonly allowNewSession: boolean
}

/** Parsed decision or the reason it was refused. */
export interface DecisionParse {
  readonly decision?: RouteDecision
  readonly error?: string
}

/**
 * Validate one routing answer.
 *
 * The model proposes; this function disposes. Every id must exist in the catalog
 * it was shown, an action that names one target must name it, and a missing
 * `prompt` falls back to the human's own text rather than to an empty turn.
 *
 * @param raw - model text.
 * @param context - valid ids and the fallback message.
 * @returns the decision, or an error naming the broken field.
 */
export function parseRouteDecision(raw: string, context: DecisionContext): DecisionParse {
  const record = decisionRecord(raw, extractJsonObject(raw))
  if (record === null) return { error: raw.trim() === '' ? 'the model returned nothing' : 'the model returned no JSON object' }
  const action = typeof record.action === 'string' ? record.action.trim() : ''
  if (!ACTIONS.includes(action as RouteAction)) return { error: `unknown action ${JSON.stringify(action)}` }
  const reason = typeof record.reason === 'string' && record.reason.trim() !== '' ? record.reason.trim() : 'routed by the model'
  const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : 0.5
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5
  const prompt = typeof record.prompt === 'string' && record.prompt.trim() !== '' ? record.prompt.trim() : context.message
  const typedAction = action as RouteAction

  if (typedAction === 'ignore') return { decision: { action: 'ignore', prompt: '', reason, confidence } }
  if (typedAction === 'reply') {
    const reply = typeof record.reply === 'string' && record.reply.trim() !== '' ? record.reply.trim() : reason
    return { decision: { action: 'reply', prompt: '', reply, reason, confidence } }
  }
  if (typedAction === 'continue') {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    if (sessionId === '') return { error: 'continue without sessionId' }
    if (!context.sessionIds.has(sessionId)) return { error: `unknown sessionId ${JSON.stringify(sessionId)}` }
    return { decision: { action: 'continue', sessionId, prompt, reason, confidence } }
  }
  if (!context.allowNewSession) return { error: 'the model chose to create a session, which is disabled in settings' }
  const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId.trim() : ''
  if (workspaceId === '') return { error: 'new session without workspaceId' }
  if (!context.workspaceIds.has(workspaceId)) return { error: `unknown workspaceId ${JSON.stringify(workspaceId)}` }
  const contextText = typeof record.context === 'string' ? record.context.trim() : ''
  if (typedAction === 'new_session_with_context') {
    if (contextText === '') return { error: 'new_session_with_context without context' }
    return { decision: { action: typedAction, workspaceId, prompt, context: contextText, reason, confidence } }
  }
  return { decision: { action: 'new_session', workspaceId, prompt, reason, confidence } }
}

/**
 * Render the text delivered to a brand-new session.
 *
 * A new session has none of the old thread, so the distilled facts go in front of
 * the human's message under a label that says where they came from. The model
 * then knows the block is inherited context, not something the user just typed.
 *
 * @param prompt - the human's message, as routed.
 * @param context - distilled facts, when the router produced any.
 * @param origin - identity of the session the facts came from.
 * @returns the text to deliver.
 */
export function composeNewSessionPrompt(prompt: string, context?: string, origin?: SummaryIdentity): string {
  const facts = (context ?? '').trim()
  if (facts === '') return prompt
  const from = origin === undefined ? 'an earlier session' : `session ${origin.session} (${origin.sessionId}) in workspace ${origin.workspace}`
  return [`Context carried over from ${from}:`, facts, '', '---', prompt].join('\n')
}

/**
 * Describe one workspace for a user-facing message.
 * @param workspace - workspace view.
 * @returns `title (path)` or a fallback.
 */
export function describeWorkspace(workspace: WorkspaceView | undefined): string {
  if (workspace === undefined) return 'unknown workspace'
  return workspace.path === '' ? workspace.title : `${workspace.title} (${workspace.path})`
}