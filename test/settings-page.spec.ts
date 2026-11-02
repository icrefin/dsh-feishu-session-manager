/**
 * The settings page, rendered from the real component.
 *
 * A static render is enough to catch the failures that would blank the Settings
 * section: a hook that throws on a missing snapshot, a control wired to a field
 * the host does not serve, a dictionary key that exists in one language only.
 *
 * @module dsh-feishu-session-manager/test/settings-page
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsSection } from '../src/client/SettingsSection.tsx'
import { en, zh, type MessageKey } from '../src/client/locales.ts'
import type { FeishuSettingsValue } from '../src/client/plugin.ts'
import { AUTHORS, VERSION } from '../src/version.ts'

/** Settings values the fake host serves. */
const VALUE: FeishuSettingsValue = {
  enabled: true,
  appId: 'cli_app',
  appSecret: 'secret',
  encryptKey: '',
  verificationToken: '',
  chatId: 'oc_chat',
  provider: 'deepseek',
  model: 'chat',
  reasoningEffort: 'high',
  routePrompt: 'route policy',
  summaryPrompt: 'summary policy',
  notifyTurnEnd: true,
  notifyError: true,
  notifyQuestion: true,
  notifyApproval: false,
  allowNewSession: true,
  inactivityMinutes: 45,
  routeMaxTokens: 2000,
  historyChars: 1200,
  maxSessions: 12,
  replyTimeoutMinutes: 15,
  chunkChars: 3200,
  language: 'auto',
  verbose: false,
}

/**
 * A settings form stand-in with no transport.
 * @param snapshot - what the form reports.
 * @returns the form.
 */
function formOf(snapshot: ConfigFormSnapshot<FeishuSettingsValue>): ConfigForm<FeishuSettingsValue> {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
}

/**
 * Render the page with one dictionary.
 * @param dictionary - the language to render.
 * @param snapshot - the form snapshot.
 * @returns the markup.
 */
function render(
  dictionary: Record<MessageKey, string>,
  snapshot: ConfigFormSnapshot<FeishuSettingsValue>,
): string {
  const t = (key: MessageKey): string => dictionary[key]
  return renderToStaticMarkup(createElement(SettingsSection, { t, form: formOf(snapshot) }))
}

/** A ready snapshot. */
const READY: ConfigFormSnapshot<FeishuSettingsValue> = {
  status: 'ready',
  value: VALUE,
  base: undefined,
  user: undefined,
  revision: 3,
  writable: true,
}

describe('the settings page', () => {
  it('renders every group and the live values in English', () => {
    const html = render(en, READY)
    expect(html).toContain('Feishu Session Manager')
    expect(html).toContain('Connection')
    expect(html).toContain('Routing policy')
    expect(html).toContain('cli_app')
    expect(html).toContain('oc_chat')
    expect(html).toContain('route policy')
    expect(html).toContain('summary policy')
    expect(html).toContain('2000')
  })

  it('prints the version and author credit beside the title', () => {
    const html = render(en, READY)
    expect(html).toContain(`v${VERSION} | Author: ${AUTHORS}`)
    expect(html).toContain('Feishu Session Manager')
  })

  it('keeps the credit when the namespace is not served', () => {
    const html = render(en, {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
    })
    expect(html).toContain(`v${VERSION} | Author: ${AUTHORS}`)
  })

  it('renders the same page in Chinese', () => {
    const html = render(zh, READY)
    expect(html).toContain('飞书会话管理器')
    expect(html).toContain('路由策略')
    expect(html).toContain('路由提示词')
  })

  it('offers both save targets and no unsaved-changes marker until something is edited', () => {
    const html = render(en, READY)
    expect(html).toContain('>Save<')
    expect(html).not.toContain('Unsaved changes')
  })

  it('hides the controls and explains itself when the host serves no namespace', () => {
    const html = render(en, {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
    })
    expect(html).toContain('does not serve this settings namespace')
    expect(html).not.toContain('App secret')
  })

  it('renders defaults while the host document is still loading', () => {
    const html = render(en, {
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: true,
    })
    expect(html).toContain('45')
    expect(html).toContain('2000')
    expect(html).toContain('Loading…')
  })

  it('disables the save path when the profile patch is not writable', () => {
    const html = render(en, { ...READY, writable: false })
    expect(html).toContain('disabled=""')
  })
})