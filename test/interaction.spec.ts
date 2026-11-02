/**
 * The waiting room for questions and permission requests.
 *
 * Grading the reply grammar here is what keeps a chat answer from being applied
 * to the wrong session: an ambiguous `1` must never silently answer one of two
 * waiting requests.
 *
 * @module dsh-feishu-session-manager/test/interaction
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InteractionRegistry,
  parseApprovalChoice,
  parseQuestionChoice,
  type PendingAnswer,
} from '../src/interaction.ts'

/** One recorded settle call. */
interface Settled {
  readonly answer: PendingAnswer
}

/**
 * Register one interaction and record how it settles.
 * @param registry - registry under test.
 * @param overrides - fields to override.
 * @returns the recorded settles and the disposer.
 */
function register(
  registry: InteractionRegistry,
  overrides: Partial<Parameters<InteractionRegistry['register']>[0]> = {},
): { settled: Settled[]; dispose: () => void } {
  const settled: Settled[] = []
  const dispose = registry.register({
    kind: 'question',
    sessionId: 's-1',
    sessionLabel: 'Task',
    summary: 'pick one',
    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    multiSelect: false,
    questionIds: ['q1'],
    timeoutMs: 60000,
    settle: (answer) => {
      settled.push({ answer })
    },
    ...overrides,
  })
  return { settled, dispose }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseApprovalChoice', () => {
  it('reads allow in its several spellings', () => {
    for (const text of ['1', 'allow', 'Allow', 'yes', 'ok', '允许', '同意']) {
      expect(parseApprovalChoice(text)).toBe('allowed-once')
    }
  })

  it('reads reject in its several spellings', () => {
    for (const text of ['2', 'reject', 'no', 'deny', '拒绝', '不允许']) {
      expect(parseApprovalChoice(text)).toBe('rejected')
    }
  })

  it('refuses anything that is not a decision', () => {
    expect(parseApprovalChoice('why?')).toBeNull()
    expect(parseApprovalChoice('')).toBeNull()
  })
})

describe('parseQuestionChoice', () => {
  it('maps a number to the option label', () => {
    const answer = parseQuestionChoice('2', [{ label: 'SQLite' }, { label: 'Postgres' }], false, ['q1'])
    expect(answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: ['Postgres'] }] })
  })

  it('keeps only the first number on a single-select question', () => {
    const answer = parseQuestionChoice('2,1', [{ label: 'a' }, { label: 'b' }], false, ['q1'])
    expect(answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: ['b'] }] })
  })

  it('collects several numbers on a multi-select question', () => {
    const answer = parseQuestionChoice('1, 3', [{ label: 'a' }, { label: 'b' }, { label: 'c' }], true, ['q1'])
    expect(answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: ['a', 'c'] }] })
  })

  it('treats free text as the custom answer', () => {
    const answer = parseQuestionChoice('use postgres 16', [{ label: 'a' }], false, ['q1'])
    expect(answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: [], custom: 'use postgres 16' }] })
  })

  it('accepts free text when the question has no options', () => {
    const answer = parseQuestionChoice('call it off', [], false, ['q1'])
    expect(answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: [], custom: 'call it off' }] })
  })

  it('refuses an index outside the menu and an empty answer', () => {
    expect(parseQuestionChoice('9', [{ label: 'a' }], false, ['q1'])).toBeNull()
    expect(parseQuestionChoice('   ', [{ label: 'a' }], false, ['q1'])).toBeNull()
  })
})

describe('InteractionRegistry', () => {
  it('answers the only waiting interaction from a bare choice', () => {
    const registry = new InteractionRegistry()
    const { settled } = register(registry)
    const dispatch = registry.answer('2')
    expect(dispatch.status).toBe('ok')
    if (dispatch.status !== 'ok') return
    expect(dispatch.sessionId).toBe('s-1')
    expect(dispatch.answer).toEqual({ kind: 'question', answers: [{ id: 'q1', selected: ['Postgres'] }] })
    expect(settled).toHaveLength(1)
    expect(registry.size).toBe(0)
  })

  it('refuses a bare choice while several wait, and names them', () => {
    const registry = new InteractionRegistry()
    register(registry, { sessionId: 's-1' })
    register(registry, { sessionId: 's-2', sessionLabel: 'Other task' })
    const dispatch = registry.answer('1')
    expect(dispatch.status).toBe('ambiguous')
    if (dispatch.status !== 'ambiguous') return
    expect(dispatch.pending).toHaveLength(2)
    expect(dispatch.message).toContain('#2 1')
    expect(registry.size).toBe(2)
  })

  it('answers the indexed interaction with the #n prefix', () => {
    const registry = new InteractionRegistry()
    const first = register(registry, { sessionId: 's-1' })
    const second = register(registry, { sessionId: 's-2', sessionLabel: 'Other task' })
    const dispatch = registry.answer('#2 1')
    expect(dispatch.status).toBe('ok')
    if (dispatch.status !== 'ok') return
    expect(dispatch.sessionId).toBe('s-2')
    expect(first.settled).toHaveLength(0)
    expect(second.settled).toHaveLength(1)
    expect(registry.size).toBe(1)
  })

  it('reports an index nobody holds', () => {
    const registry = new InteractionRegistry()
    register(registry)
    const dispatch = registry.answer('#7 1')
    expect(dispatch).toEqual({ status: 'invalid', index: 7, message: 'no interaction #7 is waiting' })
  })

  it('treats free text as not-an-answer when nothing waits', () => {
    const registry = new InteractionRegistry()
    expect(registry.answer('hello')).toEqual({ status: 'not-an-answer' })
  })

  it('answers an approval with the two outcomes', () => {
    const registry = new InteractionRegistry()
    const { settled } = register(registry, { kind: 'approval', options: [], questionIds: [], summary: 'bash' })
    const dispatch = registry.answer('1')
    expect(dispatch.status).toBe('ok')
    expect(settled[0]?.answer).toEqual({ kind: 'approval', outcome: 'allowed-once' })
  })

  it('settles once when a timeout fires', () => {
    vi.useFakeTimers()
    const registry = new InteractionRegistry()
    const { settled } = register(registry, { timeoutMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(settled).toEqual([{ answer: { kind: 'timeout' } }])
    expect(registry.size).toBe(0)
    // A later answer cannot resurrect a settled interaction.
    expect(registry.answer('1').status).toBe('not-an-answer')
    expect(settled).toHaveLength(1)
  })

  it('cancels when the requesting seam aborts', () => {
    const controller = new AbortController()
    const registry = new InteractionRegistry()
    const { settled } = register(registry, { signal: controller.signal })
    controller.abort()
    expect(settled).toEqual([{ answer: { kind: 'cancelled' } }])
  })

  it('cancels an already-aborted request at registration', () => {
    const controller = new AbortController()
    controller.abort()
    const registry = new InteractionRegistry()
    const { settled } = register(registry, { signal: controller.signal })
    expect(settled).toEqual([{ answer: { kind: 'cancelled' } }])
    expect(registry.size).toBe(0)
  })

  it('lists waiting interactions in arrival order with their session ids', () => {
    const registry = new InteractionRegistry()
    register(registry, { sessionId: 's-1', summary: 'first' })
    register(registry, { sessionId: 's-2', summary: 'second', kind: 'approval', options: [], questionIds: [] })
    expect(registry.list().map((entry) => entry.index)).toEqual([1, 2])
    expect([...registry.sessionIds()].sort()).toEqual(['s-1', 's-2'])
  })
})