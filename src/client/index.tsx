/**
 * dsh-feishu-session-manager — browser half.
 *
 * Contributes one page to the Settings panel's navigation
 * (`settings.section`). The page edits this plugin's own Loader-entry Config
 * through the shared `configForms` service, so a save lands in the same profile
 * patch file the host reads, with no second copy of the settings anywhere.
 *
 * The registration waits for two things: the Settings bundle must declare the
 * seat, and the host must actually serve this settings namespace
 * (`whileServed`). A deployment that never composed the host half therefore shows
 * no page at all, instead of a page whose save button cannot work.
 *
 * `immediately: true` in `package.json` loads this bundle at boot: the settings
 * navigation is built from registrations, so a lazily loaded bundle would leave
 * its own section missing until something else happened to load it.
 *
 * @module dsh-feishu-session-manager/client
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only imports for their declaration merging: these declare
// `settings.section` and the locale namespace map.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MessageKey } from './locales.ts'
import { SettingsSection } from './SettingsSection.tsx'
import { injectStyles } from './styles.ts'
import { NS, SECTION_ID, SETTINGS_NS, inject, type FeishuSettingsValue } from './plugin.ts'

export { NS, SECTION_ID, inject }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Keys of this plugin's own dictionary. */
    'dsh-feishu-session-manager': MessageKey
  }
}

/** Structural face of the client locale service. */
interface LocaleService {
  register(namespace: typeof NS, dictionaries: { en: typeof en; zh: typeof zh }): () => void
  bind(namespace: typeof NS): (key: MessageKey) => string
}

/** Structural face of the settings-form service this page reads and writes. */
interface ConfigFormsService {
  get<T>(entryId: string): ConfigForm<T>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** Structural face of the client slot service. */
interface SlotsService {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(key: string, callback: () => () => void): () => void
}

/** Structural face of the client root context this plugin uses. */
interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  slots: SlotsService
  locale: LocaleService
  configForms: ConfigFormsService
  logger?: { error?: (message: string, error?: unknown) => void }
}

/**
 * Register the settings page.
 *
 * An external plugin must never take the web shell down with it, so a mounting
 * failure is logged rather than thrown: the shell fails the whole boot when a
 * plugin's `apply` throws.
 *
 * @param ctx - client root context carrying the slot, locale and settings services.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), `${NS}: dictionaries`)
    const t = ctx.locale.bind(NS)
    const form = ctx.configForms.get<FeishuSettingsValue>(SETTINGS_NS)

    ctx.effect(
      () =>
        ctx.configForms.whileServed([SETTINGS_NS], () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 40,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ form }),
              },
              SettingsSection,
            ),
          ),
        ),
      `${NS}: settings section`,
    )
  } catch (error) {
    ctx.logger?.error?.(`[${NS}] the settings page could not mount`, error)
  }
}

// Materialization runs this: the client module system claims a style tag created
// from the bundle's factory body and removes it again when the plugin unloads.
injectStyles()