/**
 * Identifiers, the wire-shaped settings type, and the injection list shared by
 * the browser half and its tests.
 *
 * The settings interface mirrors the host's `Config` field by field. It is
 * re-declared instead of imported because `../config.ts` imports schemastery,
 * and a value import of the host's schema would drag a server library into the
 * browser bundle. The two stay in step by hand; a field that drifts shows up as a
 * control that saves into nothing, so both sides list the same names.
 *
 * @module dsh-feishu-session-manager/client/plugin
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-feishu-session-manager'

/** Section id inside the Settings navigation. */
export const SECTION_ID = 'feishu-session-manager'

/** Settings namespace, which equals the Loader row id. */
export const SETTINGS_NS = 'dsh-feishu-session-manager'

/**
 * Services required by the registration.
 *
 * `configForms` carries the settings document, `slots` the seat, `locale` the
 * dictionary. The Settings bundle owns the seat this plugin registers into, so
 * `dsh.client.inject` in `package.json` orders this bundle after it.
 */
export const inject = ['slots', 'locale', 'configForms'] as const

/** Settings values as the browser reads and writes them. */
export interface FeishuSettingsValue {
  enabled: boolean
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  chatId: string
  provider: string
  model: string
  reasoningEffort: string
  routePrompt: string
  summaryPrompt: string
  notifyTurnEnd: boolean
  notifyError: boolean
  notifyQuestion: boolean
  notifyApproval: boolean
  allowNewSession: boolean
  inactivityMinutes: number
  routeMaxTokens: number
  historyChars: number
  maxSessions: number
  replyTimeoutMinutes: number
  chunkChars: number
  language: string
  verbose: boolean
}

/** Field names a save may write; used by tests to prove both sides agree. */
export const SETTINGS_FIELDS: readonly (keyof FeishuSettingsValue)[] = [
  'enabled',
  'appId',
  'appSecret',
  'encryptKey',
  'verificationToken',
  'chatId',
  'provider',
  'model',
  'reasoningEffort',
  'routePrompt',
  'summaryPrompt',
  'notifyTurnEnd',
  'notifyError',
  'notifyQuestion',
  'notifyApproval',
  'allowNewSession',
  'inactivityMinutes',
  'routeMaxTokens',
  'historyChars',
  'maxSessions',
  'replyTimeoutMinutes',
  'chunkChars',
  'language',
  'verbose',
]