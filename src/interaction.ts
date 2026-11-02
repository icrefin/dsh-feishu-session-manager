/**
 * Interactions that wait for a Feishu answer.
 *
 * Two Harness seams block an agent until a human decides: `user-questions/request`
 * (a tool asked a question) and `approval/request` (a tool wants permission).
 * Both are waterflows: the plugin claims the request by returning an answer, and
 * delegates with `next()`. This registry is the waiting room between claiming and
 * returning — it holds each open request, tells the chat how to answer it, and
 * settles exactly once.
 *
 * Answering is deliberately textual. A Feishu card with buttons would need a
 * card-action callback, a schema per card, and a re-render on every state change;
 * a numbered menu costs one extra round trip for the user and nothing at all in
 * reliability. The `#N` prefix disambiguates when several sessions wait at once.
 *
 * @module dsh-feishu-session-manager/interaction
 */

import type { PendingSummary } from './protocol.ts'
import type { OptionLike } from './feishu/format.ts'

/** Which seam opened the interaction. */
export type PendingKind = 'question' | 'approval'

/** One structured answer a question can settle with. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

/** What settled one pending interaction. */
export type PendingAnswer =
  | { readonly kind: 'question'; readonly answers: readonly QuestionAnswerItem[] }
  | { readonly kind: 'approval'; readonly outcome: 'allowed-once' | 'rejected' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }

/** What one inbound text did to the waiting set. */
export type AnswerDispatch =
  | {
      readonly status: 'ok'
      readonly index: number
      /** Session the settled interaction belonged to. */
      readonly sessionId: string
      /** Display label of that session. */
      readonly sessionLabel: string
      readonly answer: PendingAnswer
    }
  | { readonly status: 'not-an-answer' }
  | { readonly status: 'ambiguous'; readonly pending: readonly PendingSummary[]; readonly message: string }
  | { readonly status: 'invalid'; readonly index: number; readonly message: string }

/** Registration of one waiting interaction. */
export interface PendingRegistration {
  readonly kind: PendingKind
  readonly sessionId: string
  readonly sessionLabel: string
  readonly summary: string
  /** Options for a question; empty for an approval. */
  readonly options: readonly OptionLike[]
  /** Whether a question accepts several selections. */
  readonly multiSelect: boolean
  /** Question ids in option order, matching the rendered menu. */
  readonly questionIds: readonly string[]
  /** Milliseconds to wait before settling as a timeout. */
  readonly timeoutMs: number
  /** Cancellation owned by the requesting seam. */
  readonly signal?: AbortSignal
  /** Called exactly once, however the interaction settles. */
  readonly settle: (answer: PendingAnswer) => void
}

/** One registered interaction. */
interface PendingRecord {
  readonly token: number
  readonly kind: PendingKind
  readonly sessionId: string
  readonly sessionLabel: string
  readonly summary: string
  readonly options: readonly OptionLike[]
  readonly multiSelect: boolean
  readonly questionIds: readonly string[]
  readonly since: number
  readonly settle: (answer: PendingAnswer) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly onAbort?: () => void
  readonly signal?: AbortSignal
}

/** The process-local set of interactions waiting for a chat answer. */
export class InteractionRegistry {
  private readonly records = new Map<number, PendingRecord>()
  private nextToken = 1

  /**
   * Register one interaction.
   *
   * @param registration - what is being asked and how to settle it.
   * @returns a disposer that cancels the interaction as `cancelled`.
   */
  register(registration: PendingRegistration): () => void {
    const token = this.nextToken
    this.nextToken += 1
    const timer = setTimeout(() => {
      this.settle(token, { kind: 'timeout' })
    }, Math.max(1, registration.timeoutMs))
    // A waiting interaction must not hold the host process open on shutdown.
    timer.unref?.()
    const onAbort =
      registration.signal === undefined
        ? undefined
        : () => {
            this.settle(token, { kind: 'cancelled' })
          }
    if (registration.signal !== undefined && onAbort !== undefined) {
      if (registration.signal.aborted) {
        clearTimeout(timer)
        registration.settle({ kind: 'cancelled' })
        return () => {}
      }
      registration.signal.addEventListener('abort', onAbort, { once: true })
    }
    this.records.set(token, {
      token,
      kind: registration.kind,
      sessionId: registration.sessionId,
      sessionLabel: registration.sessionLabel,
      summary: registration.summary,
      options: registration.options,
      multiSelect: registration.multiSelect,
      questionIds: registration.questionIds,
      since: Date.now(),
      settle: registration.settle,
      timer,
      ...(onAbort === undefined ? {} : { onAbort }),
      ...(registration.signal === undefined ? {} : { signal: registration.signal }),
    })
    return () => {
      this.settle(token, { kind: 'cancelled' })
    }
  }

  /**
   * Settle one interaction exactly once.
   * @param token - internal token.
   * @param answer - what settled it.
   */
  private settle(token: number, answer: PendingAnswer): void {
    const record = this.records.get(token)
    if (record === undefined) return
    this.records.delete(token)
    clearTimeout(record.timer)
    if (record.onAbort !== undefined && record.signal !== undefined) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
    try {
      record.settle(answer)
    } catch {
      // A settle callback owned by a disposed seam cannot fail this registry.
    }
  }

  /**
   * The interactions waiting right now, numbered from 1 in arrival order.
   * @returns display records for the panel and the chat menu.
   */
  list(): PendingSummary[] {
    return [...this.records.values()].map((record, index) => ({
      index: index + 1,
      kind: record.kind,
      sessionId: record.sessionId,
      sessionLabel: record.sessionLabel,
      summary: record.summary,
      since: record.since,
    }))
  }

  /**
   * Session ids with a waiting interaction.
   * @returns the ids.
   */
  sessionIds(): ReadonlySet<string> {
    return new Set([...this.records.values()].map((record) => record.sessionId))
  }

  /** How many interactions wait. */
  get size(): number {
    return this.records.size
  }

  /**
   * Apply one inbound text to the waiting set.
   *
   * Grammar, in precedence order:
   * - `#<n> <choice>` answers the `n`-th waiting interaction;
   * - a bare `<choice>` answers the only waiting interaction;
   * - anything else is not an answer, so the bridge can route it as normal text.
   *
   * @param text - mention-stripped inbound text.
   * @returns the dispatch outcome.
   */
  answer(text: string): AnswerDispatch {
    const trimmed = text.trim()
    if (this.records.size === 0) return { status: 'not-an-answer' }
    const targeted = /^#(\d+)\s+([\s\S]+)$/.exec(trimmed)
    if (targeted !== null) {
      const index = Number(targeted[1])
      const choice = (targeted[2] ?? '').trim()
      const record = this.byIndex(index)
      if (record === undefined) {
        return { status: 'invalid', index, message: `no interaction #${String(index)} is waiting` }
      }
      const answer = this.interpret(record, choice)
      if (answer === null) return { status: 'invalid', index, message: 'that choice does not fit this request' }
      this.settle(record.token, answer)
      return { status: 'ok', index, sessionId: record.sessionId, sessionLabel: record.sessionLabel, answer }
    }
    if (this.records.size > 1) {
      return {
        status: 'ambiguous',
        pending: this.list(),
        message: 'Several requests are waiting. Answer with `#<n> <choice>`, for example `#2 1`.',
      }
    }
    const only = [...this.records.values()][0]
    if (only === undefined) return { status: 'not-an-answer' }
    const answer = this.interpret(only, trimmed)
    if (answer === null) return { status: 'not-an-answer' }
    this.settle(only.token, answer)
    return { status: 'ok', index: 1, sessionId: only.sessionId, sessionLabel: only.sessionLabel, answer }
  }

  /**
   * Find a record by its 1-based display index.
   * @param index - display index.
   * @returns the record, or `undefined`.
   */
  private byIndex(index: number): PendingRecord | undefined {
    return [...this.records.values()][index - 1]
  }

  /**
   * Interpret one choice for one interaction.
   * @param record - the waiting interaction.
   * @param choice - the user's text after the index prefix.
   * @returns the answer, or `null` when the text does not fit.
   */
  private interpret(record: PendingRecord, choice: string): PendingAnswer | null {
    const text = choice.trim()
    if (text === '') return null
    if (record.kind === 'approval') {
      const outcome = parseApprovalChoice(text)
      return outcome === null ? null : { kind: 'approval', outcome }
    }
    return parseQuestionChoice(text, record.options, record.multiSelect, record.questionIds)
  }
}

/**
 * Read one approval decision.
 * @param text - user text.
 * @returns the outcome, or `null` when the text is neither allow nor reject.
 */
export function parseApprovalChoice(text: string): 'allowed-once' | 'rejected' | null {
  const normalized = text.trim().toLowerCase().replace(/[.!。！]$/, '')
  if (['1', 'a', 'allow', 'allowed', 'approve', 'approved', 'yes', 'y', 'ok', '允许', '同意', '批准', '是'].includes(normalized)) {
    return 'allowed-once'
  }
  if (['2', 'r', 'reject', 'rejected', 'deny', 'denied', 'no', 'n', '拒绝', '不允许', '否'].includes(normalized)) {
    return 'rejected'
  }
  return null
}

/**
 * Read a question answer.
 *
 * A single-select question treats option numbers as a selection and any other
 * text as the free-text `custom` answer, which is how `ask_user_question` models
 * "type your own". A multi-select question additionally accepts a comma list.
 *
 * @param text - user text.
 * @param options - rendered options in order.
 * @param multiSelect - whether several options may be selected.
 * @param questionIds - question ids the answer must cover.
 * @returns the answer batch, or `null` when no question can be answered.
 */
export function parseQuestionChoice(
  text: string,
  options: readonly OptionLike[],
  multiSelect: boolean,
  questionIds: readonly string[],
): PendingAnswer | null {
  if (questionIds.length === 0) return null
  const ids = questionIds
  const single = (selected: string[], custom?: string): PendingAnswer => ({
    kind: 'question',
    answers: ids.map((id, index) => ({
      id,
      selected: index === 0 ? selected : [],
      ...(index === 0 && custom !== undefined ? { custom } : {}),
    })),
  })
  const trimmed = text.trim()
  if (trimmed === '') return null
  const tokens = trimmed
    .split(/[,，\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
  const numeric = tokens.every((token) => /^\d+$/.test(token))
  if (numeric && options.length > 0) {
    const picked: string[] = []
    for (const token of multiSelect ? tokens : tokens.slice(0, 1)) {
      const index = Number(token)
      if (index < 1 || index > options.length) return null
      const option = options[index - 1]
      if (option === undefined) return null
      picked.push(option.label)
    }
    if (picked.length === 0) return null
    return single(picked)
  }
  if (options.length === 0) return single([], trimmed)
  return single([], trimmed)
}