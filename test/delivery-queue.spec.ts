/**
 * Delayed delivery.
 *
 * The reported defect: a session stopped because a tool lacked permission, and
 * the push never arrived. The activity log showed why — the host had restarted,
 * nothing had spoken to the bot yet, so the chat binding was unknown and the
 * message was dropped. A restart is not a reason to lose the one notification
 * that mattered, so undeliverable messages are now held and delivered when a chat
 * and a socket exist.
 *
 * These cases drive the real bridge with a recording transport: a stand-in for
 * the socket, nothing stubbed inside the delivery logic itself.
 *
 * @module dsh-feishu-session-manager/test/delivery-queue
 */

import { describe, expect, it } from 'vitest'
import { FeishuBridge, type BridgeDependencies, type TransportLike } from '../src/bridge.ts'
import type { TransportHandlers, TransportOptions } from '../src/feishu/client.ts'

/** One message the fake socket received. */
interface Sent {
  readonly chatId: string
  readonly text: string
}

/**
 * Build a recording transport.
 * @param sent - receives every accepted message.
 * @param fail - when true, every send rejects.
 * @returns the factory the bridge accepts.
 */
function recordingTransport(sent: Sent[], fail = false): BridgeDependencies {
  return {
    transportFactory: (_options: TransportOptions, handlers: TransportHandlers): TransportLike => ({
      start: () => {
        handlers.onState('connected')
        return Promise.resolve()
      },
      stop: () => {},
      canSend: () => true,
      sendText: (chatId: string, text: string) => {
        if (fail) return Promise.reject(new Error('feishu rejected the message'))
        sent.push({ chatId, text })
        return Promise.resolve(1)
      },
    }),
  }
}

/** Minimal host context: this path touches none of the session services. */
const ctx = {
  on: () => () => {},
  effect: (callback: () => (() => void) | void) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposer()
  },
  logger: { info() {}, debug() {}, warn() {}, error() {} },
  get: () => undefined,
} as never

/**
 * Wait for an asynchronous delivery to settle.
 * @param check - predicate that becomes true when the work finished.
 */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the delivery never settled')
}

/**
 * A config with credentials so the transport is built, and no chat yet.
 * @returns the mutable config object the bridge re-reads on every reconcile.
 */
function config(): Record<string, unknown> {
  return {
    enabled: true,
    appId: 'cli_test',
    appSecret: 'secret',
    chatId: '',
    provider: 'p',
    model: 'm',
  }
}

describe('delivery with no chat bound', () => {
  it('holds the message instead of dropping it, then delivers it on binding', async () => {
    const sent: Sent[] = []
    const settings = config()
    const bridge = new FeishuBridge(ctx, settings, recordingTransport(sent))
    bridge.reconcile()
    expect(await bridge.send('✅ Turn finished\nWorkspace: w | Session: s')).toBe(false)
    expect(sent).toHaveLength(0)
    expect((await bridge.status()).queued).toBe(1)

    settings.chatId = 'oc_chat'
    bridge.reconcile()
    await until(() => sent.length === 1)
    expect(sent[0]?.chatId).toBe('oc_chat')
    expect(sent[0]?.text).toContain('✅ Turn finished')
    expect(sent[0]?.text).toContain('⏳ Held since')
    expect((await bridge.status()).queued).toBe(0)
  })

  it('keeps held messages in order', async () => {
    const sent: Sent[] = []
    const settings = config()
    const bridge = new FeishuBridge(ctx, settings, recordingTransport(sent))
    bridge.reconcile()
    await bridge.send('first')
    await bridge.send('second')
    await bridge.send('third')
    settings.chatId = 'oc_chat'
    bridge.reconcile()
    await until(() => sent.length === 3)
    expect(sent.map((entry) => entry.text.split('\n').pop())).toEqual(['first', 'second', 'third'])
  })

  it('bounds the buffer instead of growing without limit', async () => {
    const sent: Sent[] = []
    const settings = config()
    const bridge = new FeishuBridge(ctx, settings, recordingTransport(sent))
    bridge.reconcile()
    for (let index = 0; index < 60; index += 1) await bridge.send(`message ${String(index)}`)
    expect((await bridge.status()).queued).toBe(50)
    settings.chatId = 'oc_chat'
    bridge.reconcile()
    await until(() => sent.length === 50)
    // The oldest ten were dropped; the newest survive in order.
    expect(sent[0]?.text).toContain('message 10')
    expect(sent[49]?.text).toContain('message 59')
  })
})

describe('delivery with a chat bound', () => {
  it('sends immediately and marks nothing as held', async () => {
    const sent: Sent[] = []
    const settings = config()
    settings.chatId = 'oc_chat'
    const bridge = new FeishuBridge(ctx, settings, recordingTransport(sent))
    bridge.reconcile()
    expect(await bridge.send('hello')).toBe(true)
    expect(sent).toEqual([{ chatId: 'oc_chat', text: 'hello' }])
    expect((await bridge.status()).queued).toBe(0)
  })

  it('records a refusal without retrying it forever', async () => {
    const sent: Sent[] = []
    const settings = config()
    settings.chatId = 'oc_chat'
    const bridge = new FeishuBridge(ctx, settings, recordingTransport(sent, true))
    bridge.reconcile()
    expect(await bridge.send('hello')).toBe(false)
    expect(sent).toHaveLength(0)
    expect((await bridge.status()).queued).toBe(0)
    const log = bridge.logEntries().map((entry) => entry.text).join('\n')
    expect(log).toContain('send failed')
  })
})