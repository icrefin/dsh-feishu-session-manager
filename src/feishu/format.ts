/**
 * Feishu message shapes, built and parsed without touching the network.
 *
 * Everything here is a pure function of its arguments so the interesting parts
 * — mention stripping, chunking, and the identity header every notification
 * carries — can be tested without a Feishu app, a socket, or a Harness host.
 *
 * The outbound format is deliberately plain text: a Feishu `text` message is the
 * one message type that renders identically on every client, needs no card
 * schema, and can be re-read in a notification preview. The identity header is
 * the part that matters most: one chat carries many sessions, so every push
 * names its workspace and session before it says anything else.
 *
 * @module dsh-feishu-session-manager/feishu/format
 */

/** One inbound Feishu mention placeholder. */
export interface MentionLike {
  readonly key?: string
  readonly name?: string
}

/** Everything a notification needs to identify its origin. */
export interface IdentityLike {
  /** Workspace display name. */
  readonly workspace: string
  /** Session title or short id. */
  readonly session: string
  /** Session id, shown short. */
  readonly sessionId: string
  /** Workspace path, when known. */
  readonly workspacePath?: string
}

/** One numbered question option. */
export interface OptionLike {
  readonly label: string
  readonly description?: string
}

/** Longest line shown for a workspace path inside a header. */
const PATH_HINT_MAX = 48

/**
 * Short form of a session id, for display.
 * @param sessionId - full id.
 * @returns the first eight characters, or the whole id when shorter.
 */
export function shortId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8)
}

/**
 * Render the mandatory identity line.
 * @param identity - workspace and session names.
 * @returns one line naming both, plus the short id and path hint.
 */
export function identityLine(identity: IdentityLike): string {
  const path = identity.workspacePath
  const hint = path === undefined ? '' : ` · ${path.length > PATH_HINT_MAX ? `…${path.slice(-PATH_HINT_MAX)}` : path}`
  return `Workspace: ${identity.workspace}${hint} | Session: ${identity.session} [${shortId(identity.sessionId)}]`
}

/**
 * Extract the human-readable text of one inbound Feishu message.
 *
 * Feishu delivers `text` and `post` (rich text) messages with a JSON string in
 * `content`. Every other type — a file, an image, a sticker — is reported as
 * empty, because this plugin routes text and nothing else.
 *
 * @param messageType - `message_type` of the inbound message.
 * @param content - raw `content` JSON string.
 * @returns the extracted text, never `null`.
 */
export function extractText(messageType: string | undefined, content: string | undefined): string {
  if (content === undefined || content === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (parsed === null || typeof parsed !== 'object') return ''
  const record = parsed as Record<string, unknown>
  if (messageType === 'text' || messageType === undefined) {
    const text = record.text
    return typeof text === 'string' ? text : ''
  }
  if (messageType === 'post') {
    const title = typeof record.title === 'string' ? record.title : ''
    const lines: string[] = []
    const body = record.content
    if (Array.isArray(body)) {
      for (const paragraph of body) {
        if (!Array.isArray(paragraph)) continue
        const parts: string[] = []
        for (const node of paragraph) {
          if (node === null || typeof node !== 'object') continue
          const item = node as Record<string, unknown>
          if (item.tag === 'text' && typeof item.text === 'string') parts.push(item.text)
          if (item.tag === 'a' && typeof item.text === 'string') parts.push(item.text)
        }
        if (parts.length > 0) lines.push(parts.join(''))
      }
    }
    return [title, ...lines].filter((line) => line !== '').join('\n')
  }
  return ''
}

/**
 * Remove Feishu mention placeholders such as `@_user_1` from message text.
 *
 * A mention reaches the bot as an opaque key, and leaving it in the routed
 * prompt would spend tokens on a token the model cannot resolve.
 *
 * @param text - extracted message text.
 * @param mentions - mention records carried by the event, when any.
 * @returns text with every placeholder and its surrounding spaces removed.
 */
export function stripMentions(text: string, mentions: readonly MentionLike[] | undefined): string {
  if (mentions === undefined || mentions.length === 0) return text.trim()
  let result = text
  for (const mention of mentions) {
    if (typeof mention.key !== 'string' || mention.key === '') continue
    result = result.split(mention.key).join(' ')
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Split one long text into Feishu-sized chunks.
 *
 * Feishu accepts a large `text` body, but a 40 000-character wall is unreadable
 * on a phone, so the plugin sends short messages instead. Splitting prefers a
 * blank line, then a newline, then a space, and only then cuts mid-word.
 *
 * @param text - text to send.
 * @param maxChars - chunk budget in characters (values below 200 are raised).
 * @returns one or more non-empty chunks; `[]` for empty input.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const limit = Math.max(200, Math.floor(maxChars))
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (trimmed.length <= limit) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = bestCut(window, limit)
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^[\n\s]+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/**
 * Choose the split point inside one window.
 * @param window - the candidate chunk.
 * @param limit - the hard limit.
 * @returns index to split at, always greater than zero.
 */
function bestCut(window: string, limit: number): number {
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph >= Math.floor(limit * 0.5)) return paragraph
  const line = window.lastIndexOf('\n')
  if (line >= Math.floor(limit * 0.5)) return line
  const space = window.lastIndexOf(' ')
  if (space >= Math.floor(limit * 0.5)) return space
  return limit
}

/** Header of a finished-turn notification. */
export interface CompletionNotice {
  readonly identity: IdentityLike
  /** Analyzed body from the summarizing model. */
  readonly body: string
  /** How the turn ended. */
  readonly outcome: 'completed' | 'failed'
  /** Failure code, when `outcome` is `failed`. */
  readonly failureCode?: string
}

/**
 * Build the finished-turn message.
 *
 * The identity line is always the plugin's own, never the model's: a model that
 * rephrases the workspace name would make the push ambiguous. A leading identity
 * line in the model's body is dropped so the message states it once.
 *
 * @param notice - identity, analyzed body and outcome.
 * @returns the message text, without chunking.
 */
export function formatCompletion(notice: CompletionNotice): string {
  const label = notice.outcome === 'completed' ? '✅ Turn finished' : '⚠️ Turn failed'
  const code = notice.failureCode === undefined ? '' : ` (${notice.failureCode})`
  const bodyLines = notice.body.replace(/\r\n/g, '\n').split('\n')
  while (bodyLines.length > 0) {
    const first = (bodyLines[0] ?? '').trim()
    if (first === '') {
      bodyLines.shift()
      continue
    }
    if (/^(workspace|工作区|会话|session)\s*[:：]/i.test(first)) {
      bodyLines.shift()
      continue
    }
    break
  }
  const body = bodyLines.join('\n').trim()
  const lines = [`${label}${code}`, identityLine(notice.identity), '──────────']
  if (body !== '') lines.push(body)
  return lines.join('\n')
}

/** One question plus its options, rendered for a phone. */
export interface QuestionNotice {
  readonly identity: IdentityLike
  /** Question text. */
  readonly question: string
  /** Optional header/group label. */
  readonly header?: string
  /** Optional supporting detail. */
  readonly detail?: string
  /** Options, in caller order. */
  readonly options: readonly OptionLike[]
  /** Whether several options may be selected. */
  readonly multiSelect: boolean
  /** Minutes before the request is delegated away. */
  readonly timeoutMinutes: number
}

/**
 * Build the question message, including the reply grammar.
 * @param notice - question, options and identity.
 * @returns the message text, without chunking.
 */
export function formatQuestion(notice: QuestionNotice): string {
  const lines = ['❓ Question from a session', identityLine(notice.identity), '──────────']
  if (notice.header !== undefined && notice.header !== '') lines.push(`[${notice.header}]`)
  lines.push(notice.question.trim())
  if (notice.detail !== undefined && notice.detail.trim() !== '') lines.push('', notice.detail.trim())
  if (notice.options.length > 0) {
    lines.push('')
    notice.options.forEach((option, index) => {
      const tail = option.description === undefined || option.description === '' ? '' : ` — ${option.description}`
      lines.push(`  ${index + 1}) ${option.label}${tail}`)
    })
    lines.push('')
    lines.push(
      notice.multiSelect
        ? 'Reply with option numbers separated by commas (e.g. 1,3), or type any text as your own answer.'
        : 'Reply with an option number, or type any text as your own answer.',
    )
  } else {
    lines.push('')
    lines.push('Reply with your answer as text.')
  }
  lines.push(`This request waits ${notice.timeoutMinutes} min, then the session continues without an answer.`)
  return lines.join('\n')
}

/** One permission request, rendered for a phone. */
export interface ApprovalNotice {
  readonly identity: IdentityLike
  /** Tool whose operation needs the decision. */
  readonly toolName: string
  /** Why the tool asked. */
  readonly reason?: string
  /** Minutes before the request is delegated away. */
  readonly timeoutMinutes: number
}

/**
 * Build the permission-request message.
 * @param notice - tool, reason and identity.
 * @returns the message text, without chunking.
 */
export function formatApproval(notice: ApprovalNotice): string {
  const lines = ['🔐 Permission request', identityLine(notice.identity), '──────────', `Tool: ${notice.toolName}`]
  if (notice.reason !== undefined && notice.reason.trim() !== '') lines.push(`Reason: ${notice.reason.trim()}`)
  lines.push('', 'Reply 1 to allow this one request, or 2 to reject it.')
  lines.push(`This request waits ${notice.timeoutMinutes} min, then it is rejected for lack of an answer.`)
  return lines.join('\n')
}

/**
 * Build the acknowledgment after a routed prompt.
 * @param identity - the session that received the prompt.
 * @param reason - the router's one-line explanation.
 * @param note - an honest note about how the route was decided, when it was not
 *   the model's own answer.
 * @returns the message text.
 */
export function formatRouted(identity: IdentityLike, reason: string, note?: string): string {
  const lines = [`📨 Routed`, identityLine(identity), `Why: ${reason}`]
  if (note !== undefined && note !== '') lines.push('', note)
  return lines.join('\n')
}

/**
 * Build the answer confirmation.
 * @param identity - the session that received the answer.
 * @param summary - what was sent, already human-readable.
 * @returns the message text.
 */
export function formatAnswered(identity: IdentityLike, summary: string): string {
  return [`✅ Sent to the session`, identityLine(identity), summary].join('\n')
}

/** One line of a listing. */
export interface SessionListRow {
  /** 1-based position the user can quote back. */
  readonly index: number
  readonly identity: IdentityLike
  /** Whether the session currently runs. */
  readonly running: boolean
  /** Whether the session is blocked on the user. */
  readonly waiting: boolean
  /** Last activity, epoch milliseconds. */
  readonly updatedAt: number
}

/**
 * Build the session listing.
 * @param rows - sessions to show, already ordered.
 * @param help - the help footer.
 * @returns the message text.
 */
export function formatSessionList(rows: readonly SessionListRow[], help: string): string {
  if (rows.length === 0) return `No sessions visible yet.\n\n${help}`
  const lines = ['Sessions, newest first:']
  for (const row of rows) {
    const marks = [row.running ? 'running' : 'idle', row.waiting ? 'WAITING' : ''].filter((part) => part !== '')
    lines.push(
      `${row.index}. ${row.identity.session} [${shortId(row.identity.sessionId)}] · ${row.identity.workspace} · ${marks.join(' · ')}`,
    )
  }
  lines.push('', help)
  return lines.join('\n')
}

/**
 * Build the help text.
 * @returns every command the chat accepts.
 */
export function formatHelp(): string {
  return [
    'Send any text and the router decides which session should receive it.',
    '',
    'Commands:',
    '  /sessions — list recent sessions with numbers',
    '  /use <n|id> — send the NEXT message to that session directly',
    '  /new [workspace] — create a session now instead of routing',
    '  /skip <text> — route this text even while an answer is waiting',
    '  /bind — make this chat the notification target',
    '  /status — connection and routing state',
    '  /help — this text',
    '',
    'When several interactions wait for you, answer with `#<n> <choice>`, e.g. `#2 1`.',
  ].join('\n')
}

/** State block used by `/status`. */
export interface StatusNotice {
  readonly enabled: boolean
  readonly connection: string
  readonly model: string
  readonly chatId: string
  readonly pending: number
  readonly sessions: number
  readonly running: number
}

/**
 * Build the `/status` text.
 * @param status - the values to print.
 * @returns the message text.
 */
export function formatStatus(status: StatusNotice): string {
  return [
    'Feishu Session Manager',
    `bridge: ${status.enabled ? 'on' : 'off'}`,
    `feishu: ${status.connection}`,
    `model: ${status.model}`,
    `chat: ${status.chatId}`,
    `sessions: ${status.sessions} (${status.running} running)`,
    `waiting for you: ${status.pending}`,
  ].join('\n')
}

/** Parsed shape of an inbound command. */
export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'bind' }
  | { readonly kind: 'use'; readonly target: string }
  | { readonly kind: 'new'; readonly workspaceHint: string }
  | { readonly kind: 'skip'; readonly text: string }
  | { readonly kind: 'none' }

/**
 * Parse a leading `/command`.
 * @param text - inbound text, already mention-stripped.
 * @returns the command, or `{ kind: 'none' }` when the text is not a command.
 */
export function parseCommand(text: string): Command {
  const match = /^\/([a-zA-Z]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return { kind: 'none' }
  const name = (match[1] ?? '').toLowerCase()
  const argument = (match[2] ?? '').trim()
  if (name === 'help') return { kind: 'help' }
  if (name === 'status') return { kind: 'status' }
  if (name === 'sessions') return { kind: 'sessions' }
  if (name === 'bind') return { kind: 'bind' }
  if (name === 'use') return argument === '' ? { kind: 'none' } : { kind: 'use', target: argument }
  if (name === 'new') return { kind: 'new', workspaceHint: argument }
  if (name === 'skip') return argument === '' ? { kind: 'none' } : { kind: 'skip', text: argument }
  return { kind: 'none' }
}