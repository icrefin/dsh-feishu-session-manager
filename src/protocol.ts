/**
 * Wire contract shared by the host half and the settings page.
 *
 * Both halves import this module, so a route path or payload field can never
 * drift between the host that serves it and the browser that reads it. Keep it
 * dependency-free: the client bundle inlines it.
 *
 * @module dsh-feishu-session-manager/protocol
 */

/** Loader row id; repeated here so the client bundle names its own identity. */
export const PLUGIN_ID = 'dsh-feishu-session-manager'

/** Route paths served by the host half under the web server's route table. */
export const API = {
  /** Liveness, connection state, counters and the recent activity log. */
  status: '/api/dsh-feishu-session-manager/status',
  /** Provider-grouped model catalog for the settings page's model picker. */
  models: '/api/dsh-feishu-session-manager/models',
  /** Send one real message to the bound chat. */
  test: '/api/dsh-feishu-session-manager/test',
  /** Drop and reopen the Feishu long connection against the saved credentials. */
  reconnect: '/api/dsh-feishu-session-manager/reconnect',
  /** Dry-run the routing model against a text without sending anything. */
  route: '/api/dsh-feishu-session-manager/route',
} as const

/**
 * Re-express a host route as the browser half must request it.
 *
 * A route beginning with `/` is origin-absolute, which is correct only while
 * the client is served at the origin root. The client can also be mounted under
 * a path prefix — `dsh-remote-control` serves it at `/s/<sessionId>/` — and an
 * absolute request then escapes that mount and is answered by the prefix host.
 * Dropping the leading slash resolves the request against `document.baseURI`.
 *
 * @param route - a host route path from {@link API}.
 * @returns the same route, relative to the document.
 */
export function clientPath(route: string): string {
  return route.replace(/^\//, '')
}

/** The {@link API} routes as the browser half requests them. */
export const CLIENT_API = {
  status: clientPath(API.status),
  models: clientPath(API.models),
  test: clientPath(API.test),
  reconnect: clientPath(API.reconnect),
  route: clientPath(API.route),
} as const

/** Live state of the Feishu long connection. */
export type FeishuState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'error'

/** One line of the plugin's own activity log, newest last. */
export interface LogEntry {
  /** Epoch milliseconds. */
  readonly at: number
  /** Severity of the line. */
  readonly level: 'info' | 'warn' | 'error'
  /** Human-readable text. */
  readonly text: string
}

/** One interaction the Feishu chat can currently answer. */
export interface PendingSummary {
  /** Stable index shown to the user (`#1`, `#2`, …). */
  readonly index: number
  /** What kind of answer the pending interaction expects. */
  readonly kind: 'question' | 'approval'
  /** Session id this interaction blocks. */
  readonly sessionId: string
  /** Session title or short id for display. */
  readonly sessionLabel: string
  /** One-line description of what is being asked. */
  readonly summary: string
  /** When it started waiting, epoch milliseconds. */
  readonly since: number
}

/** Body of a successful `GET API.status`. */
export interface StatusPayload {
  /** Loader row id, so the page can prove which plugin answered. */
  readonly id: string
  /** Host plugin version. */
  readonly version: string
  /** Host process id. */
  readonly pid: number
  /** Whether the master switch is on. */
  readonly enabled: boolean
  /** Which credentials and route are complete enough to run. */
  readonly configured: {
    readonly credentials: boolean
    readonly model: boolean
    /**
     * Which write-only credentials hold a value. The settings page cannot read a
     * secret back, so the host reports presence instead of content.
     */
    readonly secrets: {
      readonly appSecret: boolean
      readonly encryptKey: boolean
      readonly verificationToken: boolean
    }
    /** Chat that receives notifications, when the user or an inbound message bound one. */
    readonly chatId: string | null
  }
  /** Long-connection state. */
  readonly feishu: {
    readonly state: FeishuState
    /** Last failure or reconnect note, when there is one. */
    readonly detail?: string
    /** When the state last changed, epoch milliseconds. */
    readonly since: number
  }
  /** Counters since this host process started. */
  readonly counters: {
    readonly inbound: number
    readonly outbound: number
    readonly notifications: number
    readonly routed: number
    readonly errors: number
  }
  /** Interactions waiting for a Feishu answer, already numbered. */
  readonly pending: readonly PendingSummary[]
  /** Messages held because no chat or socket was available when they were produced. */
  readonly queued: number
  /** Sessions the catalog can see right now. */
  readonly sessions: {
    readonly total: number
    readonly running: number
    readonly waiting: number
  }
  /** Host services this plugin relies on, and whether each resolved. */
  readonly services: Readonly<Record<string, boolean>>
  /** Activity log, newest last. */
  readonly log: readonly LogEntry[]
}

/** One model offered by the host's catalog. */
export interface ModelOption {
  readonly id: string
  readonly name: string
}

/** One provider group of {@link ModelOption}s. */
export interface ModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelOption[]
}

/** Body of a successful `GET API.models`. */
export interface ModelsPayload {
  /** Provider routes whose models are currently usable. */
  readonly groups: readonly ModelGroup[]
  /** The deployment default, shown as the picker's placeholder. */
  readonly fallback: { readonly provider: string; readonly model: string } | null
  /** Providers whose catalog lookup failed, with the reason. */
  readonly failures: readonly { readonly id: string; readonly message: string }[]
}

/** Routing actions the model may choose. */
export type RouteAction = 'continue' | 'new_session' | 'new_session_with_context' | 'reply' | 'ignore'

/** One validated routing decision. */
export interface RouteDecision {
  readonly action: RouteAction
  /** Target session for `continue`. */
  readonly sessionId?: string
  /** Target workspace for the `new_session` actions. */
  readonly workspaceId?: string
  /** Text delivered to the target session. */
  readonly prompt: string
  /** Facts distilled from the old session, `new_session_with_context` only. */
  readonly context?: string
  /** Message for the human, `reply` only. */
  readonly reply?: string
  /** Why this action won, in one sentence. */
  readonly reason: string
  /** 0..1 model self-assessment; informational only. */
  readonly confidence: number
}

/** Body of a successful `POST API.route` (dry run, nothing is delivered). */
export interface RoutePreviewPayload {
  /** What the router decided, or null when it could not decide. */
  readonly decision: RouteDecision | null
  /** Raw model text when parsing failed, for diagnosis. */
  readonly raw?: string
  /** Why the preview failed, when it did. */
  readonly error?: string
  /** How many sessions and workspaces the prompt carried. */
  readonly candidates: { readonly sessions: number; readonly workspaces: number }
}

/** Request body of `POST API.test`. */
export interface TestRequest {
  /** Text to send; a fixed probe message when omitted. */
  readonly text?: string
}

/** Body of a successful `POST API.test`. */
export interface TestPayload {
  /** Whether Feishu accepted the message. */
  readonly sent: boolean
  /** Chat the message went to. */
  readonly chatId: string
  /** Human-readable outcome, including the Feishu error when refused. */
  readonly detail: string
}

/** Body of any failed request. */
export interface ErrorPayload {
  readonly error: string
}