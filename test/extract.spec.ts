/**
 * Reading a session log into a digest.
 *
 * The reader must be total: a payload it does not recognize yields no text and
 * never throws, because one unknown event must not stop the router from seeing
 * the other eleven sessions.
 *
 * @module dsh-feishu-session-manager/test/extract
 */

import { describe, expect, it } from 'vitest'
import {
  blocksText,
  digestFromEvents,
  estimateTokens,
  lastUserText,
  renderDigest,
  surfaceChars,
  surfaceEventText,
  type SurfaceEventLike,
} from '../src/session/extract.ts'

describe('blocksText', () => {
  it('joins text blocks and marks tool calls', () => {
    expect(
      blocksText([
        { type: 'text', text: 'Looking at the build.' },
        { type: 'tool-call', name: 'bash', arguments: '{}' },
      ]),
    ).toBe('Looking at the build.\n[called bash]')
  })

  it('marks attachments without emitting bytes', () => {
    expect(blocksText([{ type: 'image', data: 'AAAA' }, { type: 'file', name: 'x.log' }])).toBe('[image]\n[file]')
  })

  it('ignores reasoning and malformed blocks', () => {
    expect(blocksText([{ type: 'reasoning', text: 'thinking' }, null, 7, { type: 'text' }])).toBe('')
  })

  it('passes a string body through', () => {
    expect(blocksText('plain')).toBe('plain')
  })
})

describe('surfaceEventText', () => {
  it('reads a user message from data.content', () => {
    expect(surfaceEventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'do it' }] } })).toBe('do it')
  })

  it('reads an assistant message from data.message.content', () => {
    expect(
      surfaceEventText({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done' }] } },
      }),
    ).toBe('done')
  })

  it('returns empty for an unrecognized payload', () => {
    expect(surfaceEventText({ type: 'request/header', data: { config: {} } })).toBe('')
    expect(surfaceEventText({ type: 'user/message' })).toBe('')
  })
})

describe('digestFromEvents', () => {
  it('keeps the conversation in order and drops empty events', () => {
    const events: SurfaceEventLike[] = [
      { type: 'system/message', time: 1, data: { content: [{ type: 'text', text: 'system' }] } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'fix it' }] } },
      { type: 'tool/result', time: 3, data: { name: 'bash', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'assistant/message', time: 4, data: { message: { content: [{ type: 'text', text: 'fixed' }] } } },
    ]
    expect(digestFromEvents(events)).toEqual([
      { role: 'user', text: 'fix it', time: 2 },
      { role: 'tool', text: 'bash: ok', time: 3 },
      { role: 'assistant', text: 'fixed', time: 4 },
    ])
  })

  it('clips a long tool result so one call cannot fill the budget', () => {
    const long = 'x'.repeat(1000)
    const digest = digestFromEvents([{ type: 'tool/result', time: 1, data: { content: [{ type: 'text', text: long }] } }])
    expect((digest[0]?.text ?? '').length).toBeLessThan(260)
    expect(digest[0]?.text.endsWith('…')).toBe(true)
  })

  it('keeps only the last `limit` lines', () => {
    const events: SurfaceEventLike[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'user/message',
      time: index,
      data: { content: [{ type: 'text', text: `m${String(index)}` }] },
    }))
    expect(digestFromEvents(events, 3).map((entry) => entry.text)).toEqual(['m7', 'm8', 'm9'])
  })
})

describe('renderDigest', () => {
  it('spends the budget on the newest lines and says what it dropped', () => {
    const events: SurfaceEventLike[] = Array.from({ length: 6 }, (_, index) => ({
      type: 'user/message',
      time: index,
      data: { content: [{ type: 'text', text: `message ${String(index)}` }] },
    }))
    const text = renderDigest(digestFromEvents(events), 60)
    expect(text.startsWith('… earlier turns omitted')).toBe(true)
    expect(text).toContain('message 5')
    expect(text).not.toContain('message 0')
  })

  it('renders everything that fits and nothing when there is nothing', () => {
    expect(renderDigest([{ role: 'user', text: 'hi', time: 0 }], 100)).toBe('user: hi')
    expect(renderDigest([], 100)).toBe('')
  })
})

describe('estimateTokens', () => {
  it('leans high so a nearly-full context is not missed', () => {
    expect(estimateTokens(3200)).toBe(1000)
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(-5)).toBe(0)
  })
})

describe('surfaceChars / lastUserText', () => {
  it('sums the visible text only', () => {
    const events: SurfaceEventLike[] = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'abcde' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fgh' }] } } },
      { type: 'request/header', data: {} },
    ]
    expect(surfaceChars(events)).toBe(8)
  })

  it('returns the newest user text, or empty when there is none', () => {
    expect(
      lastUserText([
        { role: 'user', text: 'first', time: 0 },
        { role: 'assistant', text: 'reply', time: 1 },
        { role: 'user', text: 'second', time: 2 },
      ]),
    ).toBe('second')
    expect(lastUserText([])).toBe('')
  })
})