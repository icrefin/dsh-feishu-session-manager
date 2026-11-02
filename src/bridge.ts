/**
 * The bridge: Harness sessions on one side, a Feishu chat on the other.
 *
 * Nothing in this file is Feishu-specific or session-specific enough to belong
 * elsewhere. It exists to make four judgements:
 *
 * 1. which session a human's message belongs to (delegated to the routing model,
 *    validated here against the real catalog),
 * 2. whether a finished turn is worth telling the human about (and how to phrase
 *    it, delegated to the summarizing model),
 * 3. how a waiting question or permission request is presented and answered,
 * 4. when the long connection has to be (re)opened.
 *
 * Every model answer is advisory: ids are checked against the live catalog, a
 * missing prompt falls back to the human's own text, and a failed call degrades
 * to a deterministic message instead of silence.
 *
 * @module dsh-feishu-session-manager/bridge
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PLUGIN_ID, readSettings, type FeishuSettings } from './config.ts'
import { ActivityLog, Counters } from './log.ts'
import { InteractionRegistry, type PendingAnswer } from './interaction.ts'
import { FeishuTransport, type InboundMessage } from './feishu/client.ts'
import {
  formatAnswered,
  formatApproval,
  formatCompletion,
  formatHelp,
  formatQuestion,
  formatRouted,
  formatSessionList,
  formatStatus,
  identityLine,
  parseCommand,
  shortId,
  type IdentityLike,
  type SessionListRow,
} from './feishu/format.ts'
import { readCatalog, type Catalog, type SessionView } from './session/catalog.ts'
import { digestFromEvents, renderDigest, type SurfaceEventLike } from './session/extract.ts'
import { callModelText, modelRouteOf, type ModelRoute } from './llm/call.ts'
import { chooseFallbackRoute } from './llm/fallback.ts'
import {
  buildRouteUserMessage,
  buildSummaryUserMessage,
  composeNewSessionPrompt,
  normalizeSummary,
  parseRouteDecision,
  withLanguageDirective,
  type SummaryIdentity,
} from './llm/prompts.ts'
import type { FeishuState, RouteDecision, RoutePreviewPayload, StatusPayload } from './protocol.ts'
import { VERSION } from './version.ts'

/** Longest transcript block sent to the summarizing model. */
const SUMMARY_TRANSCRIPT_CHARS = 6000

/** How long a `/use` target stays armed. */
const STICKY_TTL_MS = 10 * 60 * 1000

/** Output cap for the summarizing call. */
const SUMMARY_MAX_TOKENS = 500

/** Reconcile interval for the volatile settings. */
const RECONCILE_MS = 2000

/**
 * The transport surface the bridge drives.
 *
 * Declared as an interface rather than the concrete class so a test can supply a
 * recording stand-in: delivery is the part most worth testing, and the real
 * socket would need a Feishu app.
 */
export interface TransportLike {
  start(): Promise<void>
  stop(): void
  canSend(): boolean
  sendText(chatId: string, text: string, maxChars: number): Promise<number>
}

/** Optional collaborators, overridable in tests. */
export interface BridgeDependencies {
  /** Builds the Feishu transport; omitted means the real long connection. */
  readonly transportFactory?: (
    options: ConstructorParameters<typeof FeishuTransport>[0],
    handlers: ConstructorParameters<typeof FeishuTransport>[1],
  ) => TransportLike
}

/** Most messages held while no chat was reachable. */
const HELD_LIMIT = 50

/**
 * The running bridge for one Loader row.
 *
 * One instance per mount. `start()` registers every listener and the reconcile
 * timer inside the caller's effect, so unloading the row tears all of it down.
 */
export class FeishuBridge {
  private readonly log = new ActivityLog()
  private readonly counters = new Counters()
  private readonly pending = new InteractionRegistry()
  private settings: FeishuSettings
  private transport: TransportLike | undefined
  private transportSignature = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private state: FeishuState = 'stopped'
  private stateDetail: string | undefined
  private stateSince = Date.now()
  /** Chats that have spoken to the bot; the first one becomes the notification target. */
  private readonly chats = new Set<string>()
  /** Chat already written back (or attempted), so a burst writes it once. */
  private boundChat: string | undefined
  /** Chat whose write-back is scheduled but not settled. */
  private scheduling: string | undefined
  /** Session ids of the last `/sessions` listing, in display order. */
  private lastListing: string[] = []
  /** A `/use` target, applied to the next non-command message. */
  private sticky: { sessionId: string; at: number } | undefined
  /** Highest turn-end seq already notified, per session. */
  private readonly notified = new Map<string, number>()
  /** Sessions whose newest turn failed, so the error notice already covered it. */
  private readonly failedAt = new Map<string, number>()
  /**
   * Messages with nowhere to go yet.
   *
   * A session can stop before the human has ever spoken to the bot — after a
   * restart the chat binding is unknown until the first inbound message — and a
   * push dropped at that moment is the one notification that mattered. Holding
   * them until a chat and a live socket exist is the difference between "not yet"
   * and "lost".
   */
  private readonly held: { readonly text: string; readonly chatId?: string; readonly at: number }[] = []
  /** Whether the hold state has been logged for this burst. */
  private holdLogged = false
  /** One flush at a time, so a connect burst cannot reorder messages. */
  private flushing = false

  /**
   * @param ctx - host plugin context.
   * @param config - the row's raw config, with volatile holders.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Record<string, unknown> | undefined,
    private readonly deps: BridgeDependencies = {},
  ) {
    this.settings = readSettings(config)
  }

  /**
   * Register every listener and start reconciling the connection.
   *
   * @param effect - the caller's `ctx.effect`, so cleanup runs with the row.
   */
  mount(effect: (callback: () => () => void, label?: string) => void): void {
    effect(
      () => {
        const disposers = [
          this.ctx.on('session/event', (session, event) => {
            this.onSessionEvent(session, event)
          }),
          this.ctx.on('agent/error', (payload) => {
            this.onAgentError(payload)
          }),
          this.ctx.on('user-questions/request', async (request, next) => this.onQuestion(request, next)),
          this.ctx.on('approval/request', async (request, next) => this.onApproval(request, next)),
        ]
        this.timer = setInterval(() => this.reconcile(), RECONCILE_MS)
        this.timer.unref?.()
        this.reconcile()
        return () => {
          if (this.timer !== undefined) clearInterval(this.timer)
          this.timer = undefined
          for (const dispose of disposers) dispose()
          this.transport?.stop()
          this.transport = undefined
        }
      },
      `${PLUGIN_ID}: bridge`,
    )
  }

  /**
   * Re-read the volatile settings and converge the transport to them.
   *
   * Called on a timer because a volatile field has no change notification: the
   * Loader replaces the value in place on the running fiber.
   */
  reconcile(): void {
    const next = readSettings(this.config)
    const signature = [next.enabled, next.appId, next.appSecret, next.encryptKey, next.verificationToken].join('\u0000')
    this.settings = next
    if (!next.enabled) {
      if (this.transport !== undefined) {
        this.transport.stop()
        this.transport = undefined
        this.transportSignature = ''
        this.setState('stopped', 'bridge is off')
      }
      return
    }
    if (signature === this.transportSignature) {
      // A chat id may have been typed into the settings page since the last tick.
      void this.flushHeld()
      return
    }
    this.transport?.stop()
    this.transport = undefined
    this.transportSignature = signature
    if (next.appId === '' || next.appSecret === '') {
      this.setState('error', 'app id or app secret is empty')
      return
    }
    const build = this.deps.transportFactory ?? ((options, handlers) => new FeishuTransport(options, handlers))
    const transport = build(
      {
        appId: next.appId,
        appSecret: next.appSecret,
        ...(next.encryptKey === '' ? {} : { encryptKey: next.encryptKey }),
        ...(next.verificationToken === '' ? {} : { verificationToken: next.verificationToken }),
      },
      {
        onMessage: (message) => {
          void this.ingest(message)
        },
        onState: (state, detail) => {
          this.setState(state, detail)
          if (state === 'connected') void this.flushHeld()
        },
        onLog: (level, text) => {
          this.log.add(level, text)
        },
      },
    )
    this.transport = transport
    this.setState('connecting')
    void transport.start()
    void this.flushHeld()
  }

  /**
   * Record one connection state change.
   * @param state - new state.
   * @param detail - optional note.
   */
  private setState(state: FeishuState, detail?: string): void {
    this.state = state
    this.stateDetail = detail
    this.stateSince = Date.now()
  }

  /**
   * Snapshot for the settings page.
   * @returns the current status, with live session counts when they can be read.
   */
  async status(): Promise<StatusPayload> {
    const catalog = await this.catalogOrEmpty()
    return {
      id: PLUGIN_ID,
      version: VERSION,
      pid: process.pid,
      enabled: this.settings.enabled,
      configured: {
        credentials: this.settings.appId !== '' && this.settings.appSecret !== '',
        model: modelRouteOf(this.settings.provider, this.settings.model, this.settings.reasoningEffort) !== null,
        secrets: {
          appSecret: this.settings.appSecret !== '',
          encryptKey: this.settings.encryptKey !== '',
          verificationToken: this.settings.verificationToken !== '',
        },
        chatId: this.targetChat(),
      },
      feishu: {
        state: this.state,
        ...(this.stateDetail === undefined ? {} : { detail: this.stateDetail }),
        since: this.stateSince,
      },
      counters: {
        inbound: this.counters.inbound,
        outbound: this.counters.outbound,
        notifications: this.counters.notifications,
        routed: this.counters.routed,
        errors: this.counters.errors,
      },
      pending: this.pending.list(),
      queued: this.held.length,
      sessions: {
        total: catalog.sessions.length,
        running: catalog.sessions.filter((session) => session.running).length,
        waiting: this.pending.size,
      },
      services: this.serviceAvailability(),
      log: this.log.list().slice(-60),
    }
  }

  /** Which host services this plugin relies on resolved at mount. */
  private serviceAvailability(): Record<string, boolean> {
    const names = [
      'webServer',
      'llm',
      'sessions',
      'agents',
      'sessionQuery',
      'sessionController',
      'workspaceRegistry',
      'sessionProjections',
      'userQuestions',
      'approval',
      'settings',
    ]
    const result: Record<string, boolean> = {}
    for (const name of names) result[name] = this.ctx.get(name as never) !== undefined
    return result
  }

  /** Read the current activity log. */
  logEntries(): ReturnType<ActivityLog['list']> {
    return this.log.list()
  }

  /**
   * The notification target chat: the saved setting, else the first chat that spoke.
   * @returns the chat id, or `null`.
   */
  private targetChat(): string | null {
    if (this.settings.chatId !== '') return this.settings.chatId
    const first = this.chats.values().next()
    return first.done === true ? null : first.value
  }

  /**
   * Send one text to the target chat, logging rather than throwing.
   * @param text - message body.
   * @param chatId - explicit chat, when not the target.
   * @returns whether Feishu accepted the message.
   */
  async send(text: string, chatId?: string): Promise<boolean> {
    const target = chatId ?? this.targetChat()
    const transport = this.transport
    if (target === null || transport === undefined || !transport.canSend()) {
      this.hold(text, chatId)
      return false
    }
    try {
      await transport.sendText(target, text, this.settings.chunkChars)
      this.counters.bump('outbound')
      if (this.settings.verbose) this.log.add('info', `sent ${String(text.length)} chars to ${target}`)
      return true
    } catch (error) {
      this.counters.bump('errors')
      this.log.add('error', `send failed: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Keep one message until a chat and a live socket exist.
   *
   * Bounded: an installation that never binds a chat must not grow without limit,
   * so the oldest message is dropped and the drop is recorded.
   *
   * @param text - message body.
   * @param chatId - explicit target, when the message was a reply.
   */
  private hold(text: string, chatId?: string): void {
    this.held.push({ text, ...(chatId === undefined ? {} : { chatId }), at: Date.now() })
    if (this.held.length > HELD_LIMIT) {
      this.held.shift()
      this.log.add('warn', `held-message buffer is full; the oldest of ${String(HELD_LIMIT)} was dropped`)
    }
    if (!this.holdLogged) {
      this.holdLogged = true
      this.log.add(
        'info',
        `no delivery target yet; holding messages until a chat is bound (${String(this.held.length)} held)`,
      )
    }
  }

  /**
   * Deliver everything held, oldest first, once a chat and a socket exist.
   *
   * Each message keeps a one-line marker with the time it was held, because a
   * push that arrives twenty minutes late must not read as a fresh event.
   */
  private async flushHeld(): Promise<void> {
    if (this.flushing || this.held.length === 0) return
    const transport = this.transport
    const target = this.targetChat()
    if (transport === undefined || !transport.canSend() || target === null) return
    this.flushing = true
    const batch = this.held.splice(0, this.held.length)
    let delivered = 0
    try {
      for (const item of batch) {
        const to = item.chatId ?? target
        const stamp = new Date(item.at).toLocaleTimeString()
        try {
          await transport.sendText(to, `⏳ Held since ${stamp}
${item.text}`, this.settings.chunkChars)
          this.counters.bump('outbound')
          delivered += 1
        } catch (error) {
          this.counters.bump('errors')
          this.log.add('error', `held message could not be delivered: ${messageOf(error)}`)
        }
      }
    } finally {
      this.flushing = false
      this.holdLogged = false
    }
    if (delivered > 0) this.log.add('info', `delivered ${String(delivered)} held message(s)`)
  }

  /**
   * Handle one inbound chat message.
   *
   * Public because it is the bridge's one input: the transport calls it, and a
   * test can drive the whole command, answer and routing path without a socket.
   *
   * @param message - normalized inbound message.
   */
  async ingest(message: InboundMessage): Promise<void> {
    this.counters.bump('inbound')
    this.chats.add(message.chatId)
    if (this.settings.chatId === '' && this.boundChat !== message.chatId) this.schedulePersist(message.chatId)
    // A chat exists now, so anything held before its first message can go out.
    void this.flushHeld()
    const text = message.text.trim()
    if (text === '') {
      await this.send('This bot routes text only. Send a message, or /help for commands.', message.chatId)
      return
    }

    const command = parseCommand(text)
    if (command.kind !== 'none') {
      await this.runCommand(command, message.chatId)
      return
    }

    const dispatch = this.pending.answer(text)
    if (dispatch.status === 'ok') {
      const identity = await this.identityOf(dispatch.sessionId)
      await this.send(formatAnswered(identity, describeAnswer(dispatch.answer)), message.chatId)
      return
    }
    if (dispatch.status === 'ambiguous') {
      await this.send(dispatch.message, message.chatId)
      return
    }
    if (dispatch.status === 'invalid') {
      await this.send(dispatch.message, message.chatId)
      return
    }
    if (this.pending.size > 0) {
      await this.send(`${this.menu()}\n\nTo route this text as a normal message instead, send \`/skip <text>\`.`, message.chatId)
      return
    }

    if (this.sticky !== undefined && Date.now() - this.sticky.at < STICKY_TTL_MS) {
      const target = this.sticky
      this.sticky = undefined
      const row = await this.sessionView(target.sessionId)
      if (row === undefined) {
        await this.send('That session is gone; routing the message normally instead.', message.chatId)
      } else {
        await this.deliverAndConfirm(row, text, 'you asked for this session', message.chatId)
        return
      }
    }

    await this.routeAndDeliver(text, message.chatId)
  }

  /**
   * Render the waiting-interaction menu.
   * @returns one text block listing every waiting item.
   */
  private menu(): string {
    const rows = this.pending.list()
    if (rows.length === 0) return 'Nothing is waiting for you.'
    const lines = ['Waiting for your answer:']
    for (const row of rows) {
      lines.push(`#${String(row.index)} [${row.kind}] ${row.sessionLabel}: ${row.summary}`)
    }
    return lines.join('\n')
  }

  /**
   * Run one chat command.
   * @param command - parsed command.
   * @param chatId - chat to answer in.
   */
  private async runCommand(command: ReturnType<typeof parseCommand>, chatId: string): Promise<void> {
    if (command.kind === 'help') {
      await this.send(formatHelp(), chatId)
      return
    }
    if (command.kind === 'status') {
      const catalog = await this.catalogOrEmpty()
      const running = catalog.sessions.filter((session) => session.running).length
      await this.send(
        formatStatus({
          enabled: this.settings.enabled,
          connection: this.state,
          model: this.settings.model === '' ? 'not configured' : `${this.settings.provider}/${this.settings.model}`,
          chatId: this.targetChat() ?? 'unbound',
          pending: this.pending.size,
          sessions: catalog.sessions.length,
          running,
        }),
        chatId,
      )
      return
    }
    if (command.kind === 'bind') {
      this.chats.add(chatId)
      await this.persistChat(chatId)
      await this.flushHeld()
      await this.send('This chat now receives notifications.', chatId)
      return
    }
    if (command.kind === 'sessions') {
      const catalog = await this.catalogOrEmpty()
      this.lastListing = catalog.sessions.map((session) => session.id)
      const rows: SessionListRow[] = catalog.sessions.map((session, index) => ({
        index: index + 1,
        identity: this.identityFrom(session),
        running: session.running,
        waiting: session.waiting,
        updatedAt: session.updatedAt,
      }))
      await this.send(formatSessionList(rows, 'Use `/use <n>` to send the next message to one of them.'), chatId)
      return
    }
    if (command.kind === 'use') {
      const target = await this.resolveListing(command.target)
      if (target === undefined) {
        await this.send('No such session. Send /sessions first, then `/use <n>` or `/use <id>`.', chatId)
        return
      }
      this.sticky = { sessionId: target.id, at: Date.now() }
      await this.send(`Next message goes to ${identityLine(this.identityFrom(target))}.`, chatId)
      return
    }
    if (command.kind === 'skip') {
      await this.routeAndDeliver(command.text, chatId)
      return
    }
    if (command.kind === 'new') {
      const workspace = await this.pickWorkspace(command.workspaceHint)
      if (workspace === undefined) {
        await this.send('No workspace matches that name. Send /sessions to see what exists.', chatId)
        return
      }
      const created = await this.createSession(workspace.id)
      if (created === undefined) {
        await this.send('The session could not be created.', chatId)
        return
      }
      await this.send(`Created a session: ${identityLine(this.identityFrom(created))}.`, chatId)
      return
    }
    await this.send(formatHelp(), chatId)
  }

  /**
   * Route one free-text message through the model and deliver it.
   * @param text - the human's message.
   * @param chatId - chat to answer in.
   */
  private async routeAndDeliver(text: string, chatId: string): Promise<void> {
    if (text === '') return
    const route = modelRouteOf(this.settings.provider, this.settings.model, this.settings.reasoningEffort)
    if (route === null) {
      await this.send('No model is configured for routing. Set one in Settings → Feishu Session Manager.', chatId)
      return
    }
    const catalog = await this.catalogOrEmpty()
    if (catalog.sessions.length === 0 && catalog.workspaces.length === 0) {
      await this.send('No sessions or workspaces exist yet. Nothing to route to.', chatId)
      return
    }
    const planned = await this.decideRoute(route, catalog, text, chatId)
    if (planned === undefined) return
    this.counters.bump('routed')
    await this.applyDecision(planned.decision, catalog, chatId, planned.note)
  }

  /**
   * Ask the routing model, twice, and fall back to a deterministic route.
   *
   * Two attempts are cheap next to a lost message: the first uses the policy as
   * written, the second restates the answer contract inside the user message,
   * which also covers an adapter that did not pass the system slot through. A
   * model that still produces nothing usable does not end the conversation — the
   * fallback picks a workspace from the message or from recent activity, and the
   * confirmation says so.
   *
   * @param route - the configured model.
   * @param catalog - the candidates.
   * @param text - the human's message.
   * @returns the decision to execute, or `undefined` when a reply was already sent.
   */
  private async decideRoute(
    route: ModelRoute,
    catalog: Catalog,
    text: string,
    chatId: string,
  ): Promise<{ decision: RouteDecision; note?: string } | undefined> {
    const context = {
      sessionIds: new Set(catalog.sessions.map((session) => session.id)),
      workspaceIds: new Set(catalog.workspaces.map((workspace) => workspace.id)),
      message: text,
      allowNewSession: this.settings.allowNewSession,
    }
    let lastError = 'no decision'
    for (const strict of [false, true]) {
      const result = await callModelText(this.ctx, route, {
        system: withLanguageDirective(this.settings.routePrompt, this.settings.language),
        user: buildRouteUserMessage(catalog, text, Date.now(), strict),
        maxTokens: this.settings.routeMaxTokens,
        temperature: 0,
      })
      if (result.failure !== undefined) {
        lastError = `model failure ${result.failure}`
        this.log.add(
          'warn',
          `routing attempt ${String(strict ? 2 : 1)} failed: ${lastError}`
            + ` (text ${String(result.textChunks)} deltas, reasoning ${String(result.reasoningChunks)} deltas)`,
        )
        continue
      }
      const parsed = parseRouteDecision(result.text, context)
      if (parsed.decision !== undefined) return { decision: parsed.decision }
      lastError = parsed.error ?? 'no decision'
      const shape =
        `text ${String(result.text.length)} chars from ${String(result.textChunks)} deltas`
        + `, reasoning ${String(result.reasoningChunks)} deltas`
        + `, policy ${String(this.settings.routePrompt.length)} chars`
      const head = result.text === '' ? '' : `, starts ${JSON.stringify(result.text.slice(0, 160))}`
      this.log.add('warn', `routing attempt ${String(strict ? 2 : 1)} unusable: ${lastError}; ${shape}${head}`)
    }
    this.counters.bump('errors')
    const fallback = chooseFallbackRoute(catalog, {
      message: text,
      allowNewSession: this.settings.allowNewSession,
    })
    this.log.add('warn', `routing fell back: ${fallback.reason}`)
    if (fallback.action === 'reply') {
      await this.send(fallback.reply ?? 'I could not decide where this belongs.', chatId)
      return undefined
    }
    return {
      decision: fallback,
      note: `⚠️ The routing model's answer was unusable (${lastError}). Routed by fallback.`,
    }
  }

  /**
   * Execute one validated routing decision.
   * @param decision - what the model chose.
   * @param catalog - the catalog it chose from.
   * @param chatId - chat to answer in.
   */
  private async applyDecision(
    decision: RouteDecision,
    catalog: Catalog,
    chatId: string,
    note?: string,
  ): Promise<void> {
    if (this.settings.verbose) this.log.add('info', `route: ${decision.action} — ${decision.reason}`)
    if (decision.action === 'ignore') return
    if (decision.action === 'reply') {
      await this.send(decision.reply ?? decision.reason, chatId)
      return
    }
    if (decision.action === 'continue') {
      const target = catalog.sessions.find((session) => session.id === decision.sessionId)
      if (target === undefined) {
        await this.send('The chosen session disappeared before delivery.', chatId)
        return
      }
      await this.deliverAndConfirm(target, decision.prompt, decision.reason, chatId, note)
      return
    }
    if (!this.settings.allowNewSession) {
      await this.send('Creating sessions from chat is off. Use /sessions and /use.', chatId)
      return
    }
    const created = await this.createSession(decision.workspaceId ?? '')
    if (created === undefined) {
      await this.send('The new session could not be created.', chatId)
      return
    }
    const body = composeNewSessionPrompt(decision.prompt, decision.context)
    await this.deliverAndConfirm(created, body, decision.reason, chatId, note)
  }

  /**
   * Deliver one prompt to a session and confirm it in the chat.
   * @param target - session to receive the prompt.
   * @param text - text to deliver.
   * @param reason - why this target won.
   * @param chatId - chat to answer in.
   */
  private async deliverAndConfirm(
    target: SessionView,
    text: string,
    reason: string,
    chatId: string,
    note?: string,
  ): Promise<void> {
    const delivered = await this.deliver(target.id, text)
    const identity = this.identityFrom(target)
    if (!delivered.ok) {
      this.counters.bump('errors')
      await this.send(`Could not deliver to this session: ${delivered.error ?? 'unknown error'}`, chatId)
      return
    }
    await this.send(formatRouted(identity, reason, note), chatId)
  }

  /**
   * Put one text into a session, resuming it when its Agent is cold.
   *
   * A live Agent takes the message directly through its inbox. Anything else goes
   * through the session controller, which resumes the session (retaining its
   * writer lock) and then admits the prompt through the same path the GUI uses.
   *
   * @param sessionId - target session.
   * @param text - prompt text.
   * @returns success, or the failure message.
   */
  private async deliver(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, error: 'empty prompt' }
    try {
      const handle = this.ctx.get('agents')?.get(sessionId as never)
      if (handle !== undefined) {
        handle.followup(
          createUserMessage({
            content: [{ type: 'text', text: trimmed }],
            source: { kind: 'user', rpcId: randomUUID() } as never,
          }),
        )
        return { ok: true }
      }
      await this.ctx.sessionController.prompt(
        {
          requestId: randomUUID() as never,
          sessionId: sessionId as never,
          mode: 'queue',
          content: [{ type: 'text', text: trimmed }],
        },
        AbortSignal.timeout(120000),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * Create a session in one workspace.
   * @param workspaceId - target workspace, or `''` for the first workspace.
   * @returns the new session's catalog view, when it can be read back.
   */
  private async createSession(workspaceId: string): Promise<SessionView | undefined> {
    try {
      const id =
        workspaceId !== ''
          ? workspaceId
          : (this.ctx.get('workspaceRegistry')?.list()[0]?.id ?? undefined)
      const created = await this.ctx.sessionController.create(
        id === undefined ? {} : { workspaceId: id as never },
      )
      const sessionId = String(created.sessionId)
      const catalog = await this.catalogOrEmpty()
      const found = catalog.sessions.find((session) => session.id === sessionId)
      if (found !== undefined) return found
      const registry = this.ctx.get('workspaceRegistry')
      const workspace = registry?.get(id as never)
      return {
        id: sessionId,
        title: 'new session',
        cwd: workspace === undefined ? '' : String(workspace.path),
        workspaceId: workspace === undefined ? '' : String(workspace.id),
        workspaceTitle: workspace === undefined ? 'workspace' : String(workspace.title),
        workspacePath: workspace === undefined ? '' : String(workspace.path),
        updatedAt: Date.now(),
        inactiveMinutes: 0,
        running: true,
        waiting: false,
        contextTokens: 0,
        contextWindow: 0,
        contextPercent: 0,
        digest: [],
        digestText: '',
        lastUserText: '',
      }
    } catch (error) {
      this.counters.bump('errors')
      this.log.add('error', `session create failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * Resolve a `/use` target: a listing number or a session id/prefix.
   * @param target - the user's argument.
   * @returns the catalog view, when found.
   */
  private async resolveListing(target: string): Promise<SessionView | undefined> {
    const catalog = await this.catalogOrEmpty()
    if (/^\d+$/.test(target)) {
      const index = Number(target)
      const id = this.lastListing[index - 1]
      if (id !== undefined) return catalog.sessions.find((session) => session.id === id)
      return catalog.sessions[index - 1]
    }
    return (
      catalog.sessions.find((session) => session.id === target) ??
      catalog.sessions.find((session) => session.id.startsWith(target))
    )
  }

  /**
   * Pick a workspace by a name or path fragment.
   * @param hint - the user's text.
   * @returns the workspace, the first one when no hint is given, or `undefined`.
   */
  private async pickWorkspace(hint: string): Promise<{ id: string } | undefined> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const workspaces = registry
      .list()
      .map((workspace) => ({ id: String(workspace.id), title: String(workspace.title), path: String(workspace.path) }))
    if (workspaces.length === 0) return undefined
    if (hint.trim() === '') return workspaces[0]
    const needle = hint.trim().toLowerCase()
    return (
      workspaces.find((workspace) => workspace.title.toLowerCase() === needle) ??
      workspaces.find((workspace) => workspace.title.toLowerCase().includes(needle)) ??
      workspaces.find((workspace) => workspace.path.toLowerCase().includes(needle))
    )
  }

  /**
   * Read the catalog, tolerating a missing or failing query service.
   * @returns the catalog, or an empty one.
   */
  private async catalogOrEmpty(): Promise<Catalog> {
    try {
      return await readCatalog(this.ctx, {
        maxSessions: this.settings.maxSessions,
        historyChars: this.settings.historyChars,
        pending: this.pending.sessionIds(),
      })
    } catch (error) {
      this.log.add('error', `catalog read failed: ${messageOf(error)}`)
      return { readAt: Date.now(), workspaces: [], sessions: [] }
    }
  }

  /**
   * Read one session's catalog view.
   * @param sessionId - session id.
   * @returns the view, or `undefined` when it is gone.
   */
  private async sessionView(sessionId: string): Promise<SessionView | undefined> {
    const catalog = await this.catalogOrEmpty()
    return catalog.sessions.find((session) => session.id === sessionId)
  }

  /**
   * Identity of one catalog session.
   * @param session - catalog view.
   * @returns the display identity.
   */
  private identityFrom(session: SessionView): IdentityLike {
    return {
      workspace: session.workspaceTitle === '' ? 'unknown workspace' : session.workspaceTitle,
      workspacePath: session.workspacePath,
      session: session.title,
      sessionId: session.id,
    }
  }

  /**
   * Identity of one live session object.
   * @param sessionId - session id.
   * @param cwd - working directory from the header, when known.
   * @returns the display identity.
   */
  private async identityOf(sessionId: string, cwd?: string): Promise<IdentityLike> {
    if (sessionId === '') return { workspace: 'unknown workspace', session: 'unknown session', sessionId: '' }
    const catalog = await this.catalogOrEmpty()
    const found = catalog.sessions.find((session) => session.id === sessionId)
    if (found !== undefined) return this.identityFrom(found)
    const workspace = this.workspaceNameFor(cwd)
    return {
      workspace: workspace.title,
      workspacePath: workspace.path,
      session: shortId(sessionId),
      sessionId,
    }
  }

  /**
   * Look up the workspace that owns one directory.
   * @param cwd - session working directory.
   * @returns the workspace name and path.
   */
  private workspaceNameFor(cwd: string | undefined): { title: string; path: string } {
    const registry = this.ctx.get('workspaceRegistry')
    const workspaces = registry?.list() ?? []
    const match =
      cwd === undefined ? undefined : workspaces.find((workspace) => String(workspace.path) === cwd)
    if (match !== undefined) return { title: String(match.title), path: String(match.path) }
    if (cwd === undefined || cwd === '') return { title: 'unknown workspace', path: '' }
    const parts = cwd.split('/').filter((part) => part !== '')
    return { title: parts[parts.length - 1] ?? cwd, path: cwd }
  }

  /**
   * Write the chat binding back on the next tick, once.
   *
   * The write is deferred out of the inbound callback on purpose: the settings
   * write lands in the profile patch, which runs through the Loader, and a write
   * issued inside another configuration transaction is refused with
   * `HMR transactions cannot be nested`. Deferring it also collapses a burst of
   * messages into one write. A refusal is not fatal — the chat is already bound
   * in memory for this process — so it is recorded once and never retried.
   *
   * @param chatId - chat to remember.
   */
  private schedulePersist(chatId: string): void {
    if (this.scheduling === chatId) return
    this.scheduling = chatId
    this.boundChat = chatId
    setTimeout(() => {
      void this.persistChat(chatId).finally(() => {
        this.scheduling = undefined
      })
    }, 150).unref?.()
  }

  /**
   * Persist the notification chat into the profile settings.
   * @param chatId - chat to remember.
   */
  private async persistChat(chatId: string): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    try {
      const entry = settings.describe({ redactSecrets: true }).find((descriptor) => descriptor.ns === PLUGIN_ID)
      await settings.update(PLUGIN_ID, { chatId }, entry?.revision)
      this.log.add('info', `bound chat ${chatId} for notifications`)
    } catch (error) {
      this.log.add(
        'info',
        `the chat binding stays in memory only (${messageOf(error)}); set it in the settings page to keep it across restarts`,
      )
    }
  }

  /**
   * Report one finished turn.
   *
   * The push carries an analyzed summary, not the raw tail: a phone notification
   * that quotes three tool calls is worse than no notification.
   *
   * @param session - live session object.
   * @param event - the `turn/end` event.
   */
  private onSessionEvent(
    session: { header: { id: string; cwd?: string; origin?: string; delegationDepth?: number }; id: string },
    event: { type: string; seq: number },
  ): void {
    if (!this.settings.enabled || !this.settings.notifyTurnEnd) return
    if (event.type !== 'turn/end') return
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return
    const sessionId = String(session.header.id)
    const previous = this.notified.get(sessionId) ?? -1
    if (event.seq <= previous) return
    this.notified.set(sessionId, event.seq)
    const failed = this.failedAt.get(sessionId)
    if (failed !== undefined && Date.now() - failed < 60000) return
    void this.summarizeAndSend(sessionId, session.header.cwd, 'turn-finished')
  }

  /**
   * Report one agent failure.
   * @param payload - `agent/error` payload.
   */
  private onAgentError(payload: { agent: { id: string; session: { header: { id: string; cwd?: string } } }; error: unknown }): void {
    if (!this.settings.enabled || !this.settings.notifyError) return
    const sessionId = String(payload.agent?.session?.header?.id ?? payload.agent?.id ?? '')
    if (sessionId === '') return
    this.failedAt.set(sessionId, Date.now())
    void this.summarizeAndSend(sessionId, payload.agent.session.header.cwd, 'turn-failed', messageOf(payload.error))
  }

  /**
   * Summarize one session event and send it.
   * @param sessionId - session to summarize.
   * @param cwd - working directory, for the workspace lookup.
   * @param eventKind - which event is being reported.
   * @param failureCode - failure text when the turn failed.
   */
  private async summarizeAndSend(
    sessionId: string,
    cwd: string | undefined,
    eventKind: 'turn-finished' | 'turn-failed',
    failureCode?: string,
  ): Promise<void> {
    this.counters.bump('notifications')
    const identity = await this.identityOf(sessionId, cwd)
    let transcript = ''
    try {
      const snapshot = await this.ctx.sessionQuery.readSurface(sessionId as never)
      transcript = renderDigest(
        digestFromEvents(snapshot.events as unknown as readonly SurfaceEventLike[], 30),
        SUMMARY_TRANSCRIPT_CHARS,
      )
    } catch (error) {
      this.log.add('warn', `could not read the session transcript: ${messageOf(error)}`)
    }
    const summaryIdentity: SummaryIdentity = {
      workspace: identity.workspace,
      workspacePath: identity.workspacePath ?? '',
      session: identity.session,
      sessionId: identity.sessionId,
    }
    let body = ''
    const route = modelRouteOf(this.settings.provider, this.settings.model, this.settings.reasoningEffort)
    if (route !== null) {
      const result = await callModelText(this.ctx, route, {
        system: withLanguageDirective(this.settings.summaryPrompt, this.settings.language),
        user: buildSummaryUserMessage({
          identity: summaryIdentity,
          event: eventKind,
          ...(failureCode === undefined ? {} : { failureCode }),
          transcript,
        }),
        maxTokens: SUMMARY_MAX_TOKENS,
      })
      body = result.text
      if (result.failure !== undefined) this.log.add('warn', `summary model failed: ${result.failure}`)
    }
    if (body === '') body = fallbackSummary(transcript, eventKind, failureCode)
    const normalized = normalizeSummary(body, summaryIdentity)
    await this.send(
      formatCompletion({
        identity,
        body: normalized,
        outcome: eventKind === 'turn-finished' ? 'completed' : 'failed',
        ...(failureCode === undefined ? {} : { failureCode }),
      }),
    )
  }

  /**
   * Claim one `ask_user_question` request for the chat.
   *
   * A single-question request is answered by one reply. A multi-question request
   * is presented as one menu per question; the tool call settles when every
   * question has an answer, or delegates to `next()` when one of them times out
   * or the requesting turn is cancelled.
   *
   * @param request - the question request.
   * @param next - delegate to the remaining answerers.
   * @returns the answer batch, or the delegated outcome.
   */
  private async onQuestion(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (!this.settings.enabled || !this.settings.notifyQuestion) return next()
    const agent = request.agent
    if (agent === undefined) return next()
    if (this.transport === undefined) return next()
    const sessionId = String(agent.session.header.id)
    const identity = await this.identityOf(sessionId, agent.session.header.cwd)
    const outcome = await this.collectAnswers(identity, sessionId, request.questions, request.signal)
    if (outcome === 'timeout' || outcome === 'cancelled') return next()
    return { answers: outcome }
  }

  /**
   * Ask every question of one request through the chat and wait for all answers.
   *
   * One pending record per question keeps the reply grammar honest: a question
   * with four options answers as `2`, and a request with two questions asks twice
   * instead of demanding one compound reply.
   *
   * @param identity - session identity.
   * @param sessionId - session id.
   * @param questions - questions to ask.
   * @param signal - cancellation from the requesting seam.
   * @returns the answer batch, or why it ended early.
   */
  private async collectAnswers(
    identity: IdentityLike,
    sessionId: string,
    questions: AskUserQuestionRequest['questions'],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionAnswerItem[] | 'timeout' | 'cancelled'> {
    if (questions.length === 0) return 'timeout'
    const collected = new Array<AskUserQuestionAnswerItem | undefined>(questions.length)
    return new Promise((resolve) => {
      let done = false
      const disposers: (() => void)[] = []
      const finish = (value: AskUserQuestionAnswerItem[] | 'timeout' | 'cancelled'): void => {
        if (done) return
        done = true
        for (const dispose of disposers) dispose()
        resolve(value)
      }
      questions.forEach((question, index) => {
        const disposer = this.pending.register({
          kind: 'question',
          sessionId,
          sessionLabel: identity.session,
          summary: (question.header ?? question.question).slice(0, 120),
          options: question.options ?? [],
          multiSelect: question.multiSelect === true,
          questionIds: [question.id],
          timeoutMs: this.settings.replyTimeoutMinutes * 60000,
          ...(signal === undefined ? {} : { signal }),
          settle: (answer: PendingAnswer) => {
            if (answer.kind === 'timeout') {
              finish('timeout')
              return
            }
            if (answer.kind === 'cancelled') {
              finish('cancelled')
              return
            }
            if (answer.kind !== 'question') return
            collected[index] = answer.answers[0]
            if (collected.every((item) => item !== undefined)) {
              finish(collected.filter((item): item is AskUserQuestionAnswerItem => item !== undefined))
            }
          },
        })
        disposers.push(disposer)
      })
      void this.send(
        questions
          .map((question, index) =>
            formatQuestion({
              identity,
              question: question.question,
              ...(question.header === undefined
                ? {}
                : { header: `${String(index + 1)}/${String(questions.length)} ${question.header}` }),
              ...(question.detail === undefined ? {} : { detail: question.detail }),
              options: question.options ?? [],
              multiSelect: question.multiSelect === true,
              timeoutMinutes: this.settings.replyTimeoutMinutes,
            }),
          )
          .join('\n\n──────────\n\n'),
      )
    })
  }

  /**
   * Claim one permission request for the chat.
   *
   * The decision is one-shot and the request may be withdrawn at any moment, so
   * the timeout and the requesting signal both delegate to `next()` rather than
   * inventing an outcome.
   *
   * @param request - the approval request.
   * @param next - delegate to the remaining answerers.
   * @returns the outcome, or the delegated one.
   */
  private async onApproval(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.settings.enabled || !this.settings.notifyApproval) return next()
    if (this.transport === undefined) return next()
    const sessionId = String(request.agent.session.header.id)
    const identity = await this.identityOf(sessionId, request.agent.session.header.cwd)
    let dispose: (() => void) | undefined
    const outcome = await new Promise<'allowed-once' | 'rejected' | 'timeout' | 'cancelled'>((resolve) => {
      dispose = this.pending.register({
        kind: 'approval',
        sessionId,
        sessionLabel: identity.session,
        summary: `${request.toolName}: ${request.reason ?? 'permission requested'}`.slice(0, 120),
        options: [],
        multiSelect: false,
        questionIds: [],
        timeoutMs: this.settings.replyTimeoutMinutes * 60000,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        settle: (answer: PendingAnswer) => {
          if (answer.kind === 'approval') resolve(answer.outcome)
          else if (answer.kind === 'timeout') resolve('timeout')
          else resolve('cancelled')
        },
      })
      void this.send(
        formatApproval({
          identity,
          toolName: request.toolName,
          ...(request.displayReason?.en === undefined && request.reason === undefined
            ? {}
            : { reason: request.displayReason?.en ?? request.reason }),
          timeoutMinutes: this.settings.replyTimeoutMinutes,
        }),
      )
    })
    dispose?.()
    if (outcome === 'timeout' || outcome === 'cancelled') return next()
    return outcome
  }

  /**
   * Force the next reconcile to reopen the socket.
   *
   * Used by the settings page after a credential edit: the volatile write already
   * reaches the bridge, but a signature comparison cannot tell "the same
   * credentials" from "the same variables, fixed on the other side".
   */
  forceReconnect(): void {
    this.transportSignature = `\u0000force:${String(Date.now())}`
    this.reconcile()
  }

  /**
   * Answer one text exactly as the router would, without delivering anything.
   *
   * The settings page shows the decision and its reason, which is the only way to
   * debug a misrouting prompt without waiting for a real session to move.
   *
   * @param text - the hypothetical human message.
   * @returns the decision, or why there is none.
   */
  async previewRoute(text: string): Promise<RoutePreviewPayload> {
    const catalog = await this.catalogOrEmpty()
    const candidates = { sessions: catalog.sessions.length, workspaces: catalog.workspaces.length }
    const route = modelRouteOf(this.settings.provider, this.settings.model, this.settings.reasoningEffort)
    if (route === null) return { decision: null, error: 'no model is configured', candidates }
    if (catalog.sessions.length === 0) return { decision: null, error: 'no routable session exists yet', candidates }
    const result = await callModelText(this.ctx, route, {
      system: withLanguageDirective(this.settings.routePrompt, this.settings.language),
      user: buildRouteUserMessage(catalog, text, Date.now()),
      maxTokens: this.settings.routeMaxTokens,
    })
    if (result.failure !== undefined) return { decision: null, error: result.failure, candidates }
    const parsed = parseRouteDecision(result.text, {
      sessionIds: new Set(catalog.sessions.map((session) => session.id)),
      workspaceIds: new Set(catalog.workspaces.map((workspace) => workspace.id)),
      message: text,
      allowNewSession: this.settings.allowNewSession,
    })
    if (parsed.decision === undefined) {
      return { decision: null, raw: result.text, error: parsed.error ?? 'no decision', candidates }
    }
    return { decision: parsed.decision, candidates }
  }
}

/**
 * Deterministic summary used when the model is unavailable.
 * @param transcript - bounded transcript block.
 * @param eventKind - which event is being reported.
 * @param failureCode - failure text, when the turn failed.
 * @returns a short body with no model involvement.
 */
export function fallbackSummary(
  transcript: string,
  eventKind: 'turn-finished' | 'turn-failed',
  failureCode?: string,
): string {
  const lines = transcript.split('\n').filter((line) => line.trim() !== '')
  const tail = lines.slice(-4).join('\n')
  const head =
    eventKind === 'turn-finished'
      ? 'The turn finished. The summarizing model was unavailable, so this is the raw tail:'
      : `The turn failed${failureCode === undefined ? '' : ` (${failureCode})`}. The summarizing model was unavailable, so this is the raw tail:`
  return tail === '' ? head : `${head}\n${tail}`
}

/**
 * Describe one settled interaction for the confirmation message.
 * @param answer - what settled it.
 * @returns a short human-readable line.
 */
export function describeAnswer(answer: PendingAnswer): string {
  if (answer.kind === 'approval') return answer.outcome === 'allowed-once' ? 'Allowed once.' : 'Rejected.'
  if (answer.kind === 'timeout') return 'Timed out; the request was delegated to the browser.'
  if (answer.kind === 'cancelled') return 'Cancelled by the session.'
  const parts: string[] = []
  for (const item of answer.answers) {
    if (item.selected.length > 0) parts.push(item.selected.join(', '))
    if (item.custom !== undefined && item.custom !== '') parts.push(item.custom)
  }
  return parts.length === 0 ? 'Answered.' : `Answer: ${parts.join(' / ')}`
}

/**
 * Human-readable form of an unknown thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
