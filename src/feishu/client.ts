/**
 * The Feishu transport: one long-lived WebSocket in, one REST client out.
 *
 * Feishu's event subscription has two shapes. A request URL needs a public
 * address this machine does not have, so the plugin uses the **long connection**
 * (`WSClient`): the host dials out to Feishu, and Feishu pushes events down that
 * socket. No inbound port, no tunnel, no certificate. Outbound messages use the
 * ordinary Open Platform REST API on the same app credentials.
 *
 * The plugin owns exactly one `FeishuTransport` per credential set. Everything
 * it knows about the network lives here; the bridge decides what to say.
 *
 * @module dsh-feishu-session-manager/feishu/client
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuState } from '../protocol.ts'
import { chunkText, extractText, stripMentions, type MentionLike } from './format.ts'

/** One inbound human message, normalized for the bridge. */
export interface InboundMessage {
  /** Chat the message arrived in. */
  readonly chatId: string
  /** `p2p` for a direct chat, `group` for a group chat. */
  readonly chatType: string
  /** Feishu message id, used only to drop redeliveries. */
  readonly messageId: string
  /** Plain text of the message, mentions removed. */
  readonly text: string
  /** Feishu message type, for diagnostics. */
  readonly messageType: string
}

/** Callbacks the bridge hands the transport. */
export interface TransportHandlers {
  /** One inbound message, already normalized. */
  onMessage(message: InboundMessage): void
  /** Connection state changed. */
  onState(state: FeishuState, detail?: string): void
  /** One line for the plugin's activity log. */
  onLog(level: 'info' | 'warn' | 'error', text: string): void
}

/** Construction options. */
export interface TransportOptions {
  readonly appId: string
  readonly appSecret: string
  readonly encryptKey?: string
  readonly verificationToken?: string
}

/** Live connection status as the settings page reports it. */
export interface TransportStatus {
  readonly state: FeishuState
  readonly detail?: string
  readonly since: number
}

/** How many message ids are remembered for redelivery suppression. */
const SEEN_LIMIT = 512

/**
 * Resolve the SDK's class exports.
 *
 * The package is CommonJS and its ESM interop has moved between releases: some
 * builds expose `Client` on the namespace, others only under `default`. Reading
 * both keeps one upgrade from turning every notification into
 * `client.im is undefined`.
 *
 * @returns the three classes this plugin constructs, or `null` when absent.
 */
function resolveSdk(): {
  Client: typeof lark.Client
  WSClient: typeof lark.WSClient
  EventDispatcher: typeof lark.EventDispatcher
} | null {
  const namespace = lark as unknown as Record<string, unknown>
  const nested = namespace.default as Record<string, unknown> | undefined
  const pick = (name: string): unknown => namespace[name] ?? nested?.[name]
  const Client = pick('Client')
  const WSClient = pick('WSClient')
  const EventDispatcher = pick('EventDispatcher')
  if (typeof Client !== 'function' || typeof WSClient !== 'function' || typeof EventDispatcher !== 'function') return null
  return {
    Client: Client as typeof lark.Client,
    WSClient: WSClient as typeof lark.WSClient,
    EventDispatcher: EventDispatcher as typeof lark.EventDispatcher,
  }
}

/** One Feishu app's inbound socket and outbound REST client. */
export class FeishuTransport {
  private readonly sdk = resolveSdk()
  private client: lark.Client | undefined
  private ws: lark.WSClient | undefined
  private state: FeishuState = 'stopped'
  private detail: string | undefined
  private since = Date.now()
  private starting: Promise<void> | undefined
  private readonly seen = new Set<string>()

  /**
   * @param options - app credentials.
   * @param handlers - where events and state changes go.
   */
  constructor(
    private readonly options: TransportOptions,
    private readonly handlers: TransportHandlers,
  ) {}

  /** Read the current connection status. */
  status(): TransportStatus {
    return { state: this.state, ...(this.detail === undefined ? {} : { detail: this.detail }), since: this.since }
  }

  /**
   * Set one state and notify the bridge, collapsing a repeat into nothing.
   * @param state - new state.
   * @param detail - optional note shown in the panel.
   */
  private setState(state: FeishuState, detail?: string): void {
    if (this.state === state && this.detail === detail) return
    this.state = state
    this.detail = detail
    this.since = Date.now()
    this.handlers.onState(state, detail)
  }

  /**
   * Open the long connection.
   *
   * Safe to await repeatedly: a second call while the first is still starting
   * waits for that attempt instead of opening a second socket.
   *
   * @returns after the socket handshake settles (or after a refusal).
   */
  async start(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    this.starting = this.open()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /**
   * Build the clients and begin the socket handshake.
   * @returns after the SDK accepted the parameters.
   */
  private async open(): Promise<void> {
    if (this.sdk === null) {
      this.setState('error', 'the Feishu SDK did not expose Client/WSClient/EventDispatcher')
      this.handlers.onLog('error', 'Feishu SDK shape is unexpected; is @larksuiteoapi/node-sdk installed?')
      return
    }
    if (this.options.appId === '' || this.options.appSecret === '') {
      this.setState('error', 'app id or app secret is empty')
      return
    }
    this.setState('connecting')
    try {
      const loggerLevel = (lark as unknown as { LoggerLevel?: Record<string, number> }).LoggerLevel?.warn ?? 2
      this.client = new this.sdk.Client({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        loggerLevel,
      } as ConstructorParameters<typeof lark.Client>[0])

      const dispatcher = new this.sdk.EventDispatcher({
        ...(this.options.encryptKey === undefined || this.options.encryptKey === ''
          ? {}
          : { encryptKey: this.options.encryptKey }),
        ...(this.options.verificationToken === undefined || this.options.verificationToken === ''
          ? {}
          : { verificationToken: this.options.verificationToken }),
        loggerLevel,
      })
      dispatcher.register({
        'im.message.receive_v1': (payload: unknown) => {
          this.onInbound(payload)
          return Promise.resolve()
        },
      })

      this.ws = new this.sdk.WSClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        loggerLevel,
        autoReconnect: true,
        source: 'dsh-feishu-session-manager',
        onReady: () => {
          this.setState('connected')
          this.handlers.onLog('info', 'Feishu long connection is up')
        },
        onError: (error: Error) => {
          this.setState('failed', error.message)
          this.handlers.onLog('error', `Feishu long connection failed: ${error.message}`)
        },
        onReconnecting: () => {
          this.setState('reconnecting')
          this.handlers.onLog('warn', 'Feishu long connection dropped; reconnecting')
        },
        onReconnected: () => {
          this.setState('connected')
          this.handlers.onLog('info', 'Feishu long connection restored')
        },
      })
      await this.ws.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.setState('error', messageOf(error))
      this.handlers.onLog('error', `Feishu connection could not start: ${messageOf(error)}`)
    }
  }

  /** Close the socket and forget the clients. */
  stop(): void {
    try {
      this.ws?.close({ force: true })
    } catch (error) {
      this.handlers.onLog('warn', `Feishu socket close failed: ${messageOf(error)}`)
    }
    this.ws = undefined
    this.client = undefined
    this.setState('stopped')
  }

  /**
   * Whether an outbound message can be attempted at all.
   * @returns true when the REST client exists.
   */
  canSend(): boolean {
    return this.client !== undefined
  }

  /**
   * Send one or more text messages to a chat.
   * @param chatId - target `chat_id`.
   * @param text - message body; split when longer than `maxChars`.
   * @param maxChars - chunk budget.
   * @returns the number of messages Feishu accepted.
   * @throws when the client is absent or Feishu refuses a message.
   */
  async sendText(chatId: string, text: string, maxChars: number): Promise<number> {
    const client = this.client
    if (client === undefined) throw new Error('Feishu transport is not connected')
    const chunks = chunkText(text, maxChars)
    let sent = 0
    for (const chunk of chunks) {
      const response = (await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      })) as { code?: number; msg?: string }
      if (typeof response?.code === 'number' && response.code !== 0) {
        throw new Error(`feishu rejected the message: ${response.code} ${response.msg ?? ''}`.trim())
      }
      sent += 1
      if (chunks.length > 1) await delay(250)
    }
    return sent
  }

  /**
   * Normalize one `im.message.receive_v1` payload into a bridge message.
   * @param payload - raw event body from the SDK.
   */
  private onInbound(payload: unknown): void {
    const event = asRecord(payload)
    if (event === null) return
    if (asRecord(event.header)?.event_type !== undefined) {
      const type = asRecord(event.header)?.event_type
      if (type !== 'im.message.receive_v1') return
    }
    const message = asRecord(event.message)
    if (message === null) return
    const sender = asRecord(event.sender)
    if (asRecord(sender?.sender_id)?.sender_type === 'app' || sender?.sender_type === 'app') return
    const messageId = asString(message.message_id)
    if (messageId === '') return
    if (this.seen.has(messageId)) return
    this.seen.add(messageId)
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next()
      if (oldest.done !== true) this.seen.delete(oldest.value)
    }
    const chatId = asString(message.chat_id)
    if (chatId === '') return
    const messageType = asString(message.message_type)
    const text = stripMentions(
      extractText(messageType, asString(message.content)),
      Array.isArray(message.mentions) ? (message.mentions as MentionLike[]) : undefined,
    )
    this.handlers.onMessage({
      chatId,
      chatType: asString(message.chat_type),
      messageId,
      text,
      messageType,
    })
  }
}

/**
 * Narrow an unknown value to a plain record.
 * @param value - candidate.
 * @returns the record, or `null`.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Read a string field defensively.
 * @param value - candidate.
 * @returns the string, or `''`.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Human-readable form of an unknown thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait, used only to space out a multi-part message.
 * @param ms - milliseconds.
 * @returns a promise settling after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}