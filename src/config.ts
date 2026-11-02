/**
 * The Loader row's Config — and therefore this plugin's settings namespace.
 *
 * Every field is `.volatile()`: the Loader updates a volatile value in place on
 * the running fiber, so a settings page writes it and the bridge (already
 * mounted) reads the new value on its next tick with no reload. A volatile
 * field arrives at `apply()` as a live holder, not a plain value, which is why
 * every read goes through {@link readField}.
 *
 * Two prompt fields carry the plugin's own defaults. They are part of the
 * schema rather than constants inside the bridge so that a user can replace
 * them from the settings page, and `DEFAULT_*` here is what "Reset" restores.
 *
 * @module dsh-feishu-session-manager/config
 */

import z from '@deepseek-ai/schemastery'

/** Loader row id, package name, client bundle id and settings namespace. */
export const PLUGIN_ID = 'dsh-feishu-session-manager'

/**
 * Default routing prompt.
 *
 * The routing model receives one JSON catalog plus the inbound text and must
 * answer with one JSON object. Every routing rule the plugin implements is
 * stated here, because this text is the whole policy: relevance first, then
 * workspace, then context length, then inactivity. The plugin re-validates the
 * answer and never trusts the model with an id that is not in the catalog.
 */
export const DEFAULT_ROUTE_PROMPT = `You are the router of a DeepSeek Harness installation.
Every Harness session lives in a workspace (a project directory).
A human writes to you through Feishu IM. Decide where their message belongs.

You receive:
1. Now (ISO time), the sender's chat, workspaces with ids, and candidate sessions.
   Each session carries: id, title, workspaceId, updatedAt (epoch ms), inactiveMinutes,
   running, waiting (blocked on a question or a permission request), contextTokens,
   contextWindow and contextPercent (its own model's capacity and the share already
   used), and a short transcript tail.
2. The human's message.

Choose exactly one action:

- "continue": the message continues the work of one existing session.
  Use it when the message clearly refers to that session's topic, files, or decision,
  the session is not stale, and its context is not nearly full.
- "new_session": the message starts unrelated work, or the matching session is a poor
  host (see the two replacement rules below), and no old context is worth carrying.
- "new_session_with_context": the message belongs to an existing session's topic, but a
  fresh session is the better host. Distil the facts the new session cannot work
  without into "context".
- "reply": no session can be chosen (ambiguous, or nothing exists yet and creating one
  would be wrong). Write a short question back to the human.
- "ignore": the message is noise, a duplicate, or a courtesy message that needs no work.

Replace an existing session when either is true:
- Context pressure: contextPercent is 60 or higher — that is the session's own model
  window, not a budget of yours, so a high percentage means the next turn is close to
  compaction. When contextWindow is null the capacity is unknown: then decide from the
  transcript tail. A new session is cheaper and more reliable; carry over the facts the
  work needs, not the history.
- Inactivity: inactiveMinutes is large (rule of thumb: over 45 minutes) and the message
  starts new work rather than continuing a thread. Long-idle sessions lose their KV cache,
  so reusing them is no cheaper than starting fresh.

Workspace choice:
- Prefer the workspace whose session already owns the topic.
- Otherwise match the workspace name or path against the message and file paths it mentions.
- "new_session" and "new_session_with_context" must name a real workspaceId from the input.
  Never invent one.

Also decide "prompt": the text handed to the target session's model. Keep the human's
wording and intent. Add no greetings, no meta commentary, and no translation. For
"new_session_with_context", keep this prompt self-contained: the target session has none
of the old thread, so fold the essential facts in.

Answer with ONE JSON object and nothing else. No prose, no code fence:
{
  "action": "continue" | "new_session" | "new_session_with_context" | "reply" | "ignore",
  "sessionId": "<existing session id, continue only>",
  "workspaceId": "<workspace id, new_session actions only>",
  "prompt": "<text for the target session>",
  "context": "<distilled facts to inject, new_session_with_context only>",
  "reply": "<short message for the human, reply only>",
  "reason": "<one short sentence naming the deciding factor>",
  "confidence": 0.0
}

Use "reply" and "ignore" sparingly: a wrong "continue" costs one confused turn, while a
wrong "new_session" loses the thread the human meant.

A request for a new plugin, feature, tool or investigation is new work: choose a
"new_session" action in the workspace it belongs to, unless an existing session is already
about that exact piece of work. Do not answer with prose, reasoning, or commentary — the
whole reply is the JSON object.`

/**
 * Default summarizer prompt.
 *
 * Used for a turn that just finished and for a failed turn. The first line is
 * mandated because a Feishu reader sees many sessions in one chat and must be
 * able to tell them apart without scrolling. The plugin re-checks that line and
 * prepends a deterministic header when the model omits it.
 */
export const DEFAULT_SUMMARY_PROMPT = `You summarize a DeepSeek Harness session for a human reading Feishu IM
on a phone. The human cannot see the session, its tools, or its files.

You receive the session identity, its workspace, its current status, why this summary
exists, and the tail of the conversation.

Reply in plain text, in the same language as the human's most recent message, with at most
120 words. No markdown tables, no code fences, no headings with #.

Line 1 MUST name the workspace and the session, in this shape:
Workspace: <workspace name> | Session: <session title or short id>

Then:
- What happened: the outcome of the finished work, in one or two sentences. Report what
  was actually done, not what the assistant intended to do.
- Needs you: one sentence, only when the human must decide, approve, or supply something.
  Omit the section when nothing is needed.
- Next: one sentence naming the obvious next step, only when it is genuinely implied.

Never invent file paths, numbers, or results you were not given. If the turn failed, say
what failed and what the failure suggests.`

/**
 * The plugin's settings, every field writable while the host runs.
 *
 * Defaults keep the plugin inert: it is disabled, has no credentials, and has no
 * model route until the user opens the settings page.
 */
export const Config = z.object({
  /** Master switch for the whole bridge (Feishu connection and notifications). */
  enabled: z.boolean().default(false).volatile(),
  /** Feishu app id (`cli_…`) of the bot whose long connection the plugin opens. */
  appId: z.string().default('').volatile(),
  /**
   * Feishu app secret.
   *
   * Declared `secret`: the settings wire never carries it, so a remote browser
   * cannot read it back. The page shows a write-only field, and an untouched
   * field is left exactly as it is.
   */
  appSecret: z.string().default('').volatile().role('secret'),
  /** Optional Encrypt Key, required only when the app encrypts event payloads. */
  encryptKey: z.string().default('').volatile().role('secret'),
  /** Optional Verification Token, checked on inbound events when set. */
  verificationToken: z.string().default('').volatile().role('secret'),
  /** Feishu `chat_id` that receives notifications. Bound automatically on first message. */
  chatId: z.string().default('').volatile(),
  /** Provider route of the model that summarizes and routes. */
  provider: z.string().default('').volatile(),
  /** Model id of the summarizing and routing model. */
  model: z.string().default('').volatile(),
  /** Optional reasoning effort for that model. */
  reasoningEffort: z.string().default('').volatile(),
  /** Policy text for the routing model. */
  routePrompt: z.string().default(DEFAULT_ROUTE_PROMPT).volatile(),
  /** Policy text for the summarizing model. */
  summaryPrompt: z.string().default(DEFAULT_SUMMARY_PROMPT).volatile(),
  /** Push an analysis when a turn finishes. */
  notifyTurnEnd: z.boolean().default(true).volatile(),
  /** Push a notice when a turn ends in an agent error. */
  notifyError: z.boolean().default(true).volatile(),
  /** Push an `ask_user_question` prompt and accept its answer from Feishu. */
  notifyQuestion: z.boolean().default(true).volatile(),
  /** Push a permission request and accept its decision from Feishu. */
  notifyApproval: z.boolean().default(true).volatile(),
  /** Let the router create a new session when it decides to. */
  allowNewSession: z.boolean().default(true).volatile(),
  /** Idle minutes above which the router is told a session may be replaced. */
  inactivityMinutes: z.number().default(45).volatile(),
  /**
   * Output cap for one routing call.
   *
   * Reasoning tokens count against this cap, so a small value can cut the JSON
   * mid-object before the model writes it. The shipped default leaves room for a
   * thousand reasoning tokens and the answer.
   */
  routeMaxTokens: z.number().default(2000).volatile(),
  /** Transcript characters per candidate session sent to the router. */
  historyChars: z.number().default(1200).volatile(),
  /** Maximum candidate sessions sent to the router. */
  maxSessions: z.number().default(12).volatile(),
  /** Minutes to wait for a Feishu answer to a question or a permission request. */
  replyTimeoutMinutes: z.number().default(15).volatile(),
  /** Maximum characters per outgoing Feishu message before it is split. */
  chunkChars: z.number().default(3200).volatile(),
  /** Reply language: `auto` follows the human, or `en` / `zh` forces one. */
  language: z.string().default('auto').volatile(),
  /** Log every routed decision and every outbound message to the host log. */
  verbose: z.boolean().default(false).volatile(),
})

/** Plain, defaulted view of {@link Config} as the bridge reads it each tick. */
export interface FeishuSettings {
  readonly enabled: boolean
  readonly appId: string
  readonly appSecret: string
  readonly encryptKey: string
  readonly verificationToken: string
  readonly chatId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly routePrompt: string
  readonly summaryPrompt: string
  readonly notifyTurnEnd: boolean
  readonly notifyError: boolean
  readonly notifyQuestion: boolean
  readonly notifyApproval: boolean
  readonly allowNewSession: boolean
  readonly inactivityMinutes: number
  readonly routeMaxTokens: number
  readonly historyChars: number
  readonly maxSessions: number
  readonly replyTimeoutMinutes: number
  readonly chunkChars: number
  readonly language: string
  readonly verbose: boolean
}

/** A volatile config field: a live holder, a plain value, or absent. */
type Field = unknown

/**
 * Read one setting in either shape a mount can produce.
 *
 * A volatile field is a holder with `get()`; a schema-less mount hands over the
 * plain value. Neither shape is assumed.
 *
 * @param field - the config field as `apply` received it.
 * @param fallback - value to use when the field is absent or the wrong type.
 * @returns the current value, or `fallback`.
 */
function readField<T>(field: Field, fallback: T): T {
  if (field === undefined || field === null) return fallback
  const holder = field as { get?: unknown }
  const value = typeof holder.get === 'function' ? (field as { get(): unknown }).get() : field
  return value === undefined || value === null ? fallback : (value as T)
}

/**
 * Read a string setting.
 * @param field - the config field.
 * @param fallback - value when the field is absent or not a string.
 * @returns the trimmed-or-plain string setting.
 */
export function readString(field: Field, fallback = ''): string {
  const value = readField<unknown>(field, fallback)
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a boolean setting.
 * @param field - the config field.
 * @param fallback - value when the field is absent or not a boolean.
 * @returns the boolean setting.
 */
export function readBoolean(field: Field, fallback = false): boolean {
  const value = readField<unknown>(field, fallback)
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Use the fallback when a string setting is blank.
 * @param value - the configured value.
 * @param fallback - the shipped default.
 * @returns the value, or the fallback when the value has no non-space content.
 */
export function nonBlank(value: string, fallback: string): string {
  return value.trim() === '' ? fallback : value
}

/**
 * Read a number setting.
 * @param field - the config field.
 * @param fallback - value when the field is absent or not a finite number.
 * @returns the numeric setting.
 */
export function readNumber(field: Field, fallback = 0): number {
  const value = readField<unknown>(field, fallback)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Snapshot every setting the bridge needs from one raw config object.
 *
 * Called on every reconcile tick rather than cached, because a volatile write
 * replaces the holder's value in place and there is no change event to subscribe
 * to.
 *
 * @param config - the row config as `apply` received it, possibly undefined.
 * @returns a fully defaulted, plain settings snapshot.
 */
export function readSettings(config: Record<string, unknown> | undefined): FeishuSettings {
  const source = config ?? {}
  return {
    enabled: readBoolean(source.enabled, false),
    appId: readString(source.appId, '').trim(),
    appSecret: readString(source.appSecret, '').trim(),
    encryptKey: readString(source.encryptKey, '').trim(),
    verificationToken: readString(source.verificationToken, '').trim(),
    chatId: readString(source.chatId, '').trim(),
    provider: readString(source.provider, '').trim(),
    model: readString(source.model, '').trim(),
    reasoningEffort: readString(source.reasoningEffort, '').trim(),
    // A blank policy is never meaningful, and a request whose system slot ends up
    // holding nothing but the language line makes a model answer with no JSON at
    // all — so a cleared field falls back to the shipped policy instead.
    routePrompt: nonBlank(readString(source.routePrompt, DEFAULT_ROUTE_PROMPT), DEFAULT_ROUTE_PROMPT),
    summaryPrompt: nonBlank(readString(source.summaryPrompt, DEFAULT_SUMMARY_PROMPT), DEFAULT_SUMMARY_PROMPT),
    notifyTurnEnd: readBoolean(source.notifyTurnEnd, true),
    notifyError: readBoolean(source.notifyError, true),
    notifyQuestion: readBoolean(source.notifyQuestion, true),
    notifyApproval: readBoolean(source.notifyApproval, true),
    allowNewSession: readBoolean(source.allowNewSession, true),
    inactivityMinutes: readNumber(source.inactivityMinutes, 45),
    routeMaxTokens: readNumber(source.routeMaxTokens, 2000),
    historyChars: readNumber(source.historyChars, 1200),
    maxSessions: readNumber(source.maxSessions, 12),
    replyTimeoutMinutes: readNumber(source.replyTimeoutMinutes, 15),
    chunkChars: readNumber(source.chunkChars, 3200),
    language: nonBlank(readString(source.language, 'auto'), 'auto'),
    verbose: readBoolean(source.verbose, false),
  }
}