/**
 * Turning a session log into the few lines a model can actually use.
 *
 * Two consumers want different slices of the same log: the summarizer wants the
 * tail of the conversation that just finished, and the router wants a bounded
 * digest of every candidate session. Both read *surface* events — the messages
 * the model itself saw — rather than the raw log, because the raw log also holds
 * tool calls, headers, and compaction events that would only cost tokens.
 *
 * Every reader here is total: a foreign payload shape yields empty text instead
 * of throwing. A session written by a newer Harness must not be able to break
 * the router.
 *
 * @module dsh-feishu-session-manager/session/extract
 */

/** One event-like record as read from the session query or the live feed. */
export interface SurfaceEventLike {
  /** Event discriminant, e.g. `user/message`. */
  readonly type: string
  /** Epoch milliseconds, when the record carries one. */
  readonly time?: number
  /** Event payload. */
  readonly data?: unknown
}

/** One normalized transcript line. */
export interface DigestEntry {
  /** Who produced the line. */
  readonly role: 'user' | 'assistant' | 'tool' | 'system'
  /** Flattened text, never empty. */
  readonly text: string
  /** Epoch milliseconds; `0` when the source carried none. */
  readonly time: number
}

/** Longest single tool line kept in a digest, in characters. */
const TOOL_LINE_MAX = 240

/**
 * Narrow an unknown value to a plain record.
 * @param value - candidate.
 * @returns the record, or `null`.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Flatten one content-block array into text.
 *
 * Text blocks contribute their text; tool calls contribute a compact
 * `[tool name]` marker so a digest still shows that work happened. Images and
 * files contribute a marker, never bytes.
 *
 * @param content - candidate content-block array.
 * @returns the flattened text, possibly empty.
 */
export function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === null) continue
    const type = record.type
    if (type === 'text' && typeof record.text === 'string' && record.text.trim() !== '') {
      parts.push(record.text.trim())
      continue
    }
    if (type === 'tool-call' && typeof record.name === 'string') {
      parts.push(`[called ${record.name}]`)
      continue
    }
    if (type === 'reasoning') continue
    if (type === 'image') parts.push('[image]')
    else if (type === 'file') parts.push('[file]')
  }
  return parts.join('\n').trim()
}

/**
 * Read the text of one surface event.
 * @param event - one surface event.
 * @returns its flattened text, or `''` when the shape is unknown.
 */
export function surfaceEventText(event: SurfaceEventLike): string {
  const data = asRecord(event.data)
  if (data === null) return ''
  const message = asRecord(data.message)
  const candidate = message?.content ?? data.content
  return blocksText(candidate)
}

/**
 * Read the tool name carried by a tool result, when it carries one.
 * @param event - one surface event.
 * @returns the tool name, or `''`.
 */
function toolName(event: SurfaceEventLike): string {
  const data = asRecord(event.data)
  if (data === null) return ''
  const direct = data.name
  if (typeof direct === 'string') return direct
  const call = asRecord(data.toolCall) ?? asRecord(data.call)
  const nested = call?.name
  return typeof nested === 'string' ? nested : ''
}

/**
 * Project surface events into normalized transcript lines.
 *
 * Only the last `limit` lines are kept: a digest exists to show the router what
 * a session is about right now, and an old turn adds tokens without changing the
 * decision.
 *
 * @param events - surface events in model-history order.
 * @param limit - maximum retained lines.
 * @returns transcript lines, oldest first.
 */
export function digestFromEvents(events: readonly SurfaceEventLike[], limit = 40): DigestEntry[] {
  const entries: DigestEntry[] = []
  for (const event of events) {
    const time = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'user/message') {
      const text = surfaceEventText(event)
      if (text !== '') entries.push({ role: 'user', text, time })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = surfaceEventText(event)
      if (text !== '') entries.push({ role: 'assistant', text, time })
      continue
    }
    if (event.type === 'tool/result') {
      const text = surfaceEventText(event)
      if (text === '') continue
      const name = toolName(event)
      const clipped = text.length > TOOL_LINE_MAX ? `${text.slice(0, TOOL_LINE_MAX)}…` : text
      entries.push({ role: 'tool', text: name === '' ? clipped : `${name}: ${clipped}`, time })
      continue
    }
    if (event.type === 'system/message') {
      continue
    }
  }
  return entries.length > limit ? entries.slice(entries.length - limit) : entries
}

/**
 * Render transcript lines into one bounded block.
 *
 * The newest lines win the budget: a truncated head is prefixed with a marker so
 * the model knows the history continues earlier.
 *
 * @param entries - transcript lines, oldest first.
 * @param maxChars - character budget for the rendered block.
 * @returns the rendered transcript, possibly empty.
 */
export function renderDigest(entries: readonly DigestEntry[], maxChars: number): string {
  const rendered: string[] = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    const line = `${entry.role}: ${entry.text.replace(/\s+/g, ' ').trim()}`
    if (used + line.length > maxChars && rendered.length > 0) break
    rendered.unshift(line)
    used += line.length
  }
  if (rendered.length < entries.length) rendered.unshift('… earlier turns omitted')
  return rendered.join('\n')
}

/**
 * Estimate the token size of one surface log.
 *
 * A real measurement exists for a live session (the `contextPressure`
 * projection), and the catalog prefers it. This estimate is the fallback for a
 * cold session and for a log the projection has not folded yet; code-heavy text
 * runs nearer three characters per token than four, so the estimate leans high,
 * which is the safe direction for a "context is nearly full" decision.
 *
 * @param chars - total characters of the surface text.
 * @returns an integer token estimate.
 */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.round(chars / 3.2)
}

/**
 * Total characters of one surface log.
 * @param events - surface events.
 * @returns the summed text length.
 */
export function surfaceChars(events: readonly SurfaceEventLike[]): number {
  let total = 0
  for (const event of events) total += surfaceEventText(event).length
  return total
}

/**
 * The most recent user text in a digest, or `''`.
 * @param entries - transcript lines, oldest first.
 * @returns the newest user line.
 */
export function lastUserText(entries: readonly DigestEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.role === 'user') return entry.text
  }
  return ''
}