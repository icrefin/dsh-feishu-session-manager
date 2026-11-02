/**
 * The settings page.
 *
 * One page, six groups, one sticky save. Every control edits a local draft and a
 * single `mutate` writes the whole draft in one atomic revision, which is why the
 * page never leaves the profile patch half-written: a credential and the model
 * that should use it land together or not at all.
 *
 * The status half is read-only and polls the host's own route, so a connection
 * that fails says why in the page rather than only in the host log.
 *
 * @module dsh-feishu-session-manager/client/SettingsSection
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelsPayload, RoutePreviewPayload, StatusPayload } from '../protocol.ts'
import { getModels, getStatus, postReconnect, postRoute, postTest } from './api.ts'
import {
  ActionButton,
  Group,
  NumberField,
  Row,
  SelectField,
  TextAreaField,
  TextField,
  Toggle,
  type Option,
} from './Controls.tsx'
import { AUTHORS, VERSION } from '../version.ts'
import type { FeishuSettingsValue } from './plugin.ts'
import type { MessageKey } from './locales.ts'

/** Props composed by the slot framework plus this plugin's own injection. */
export interface SettingsSectionProps {
  /** Translate seat bound to the plugin's locale namespace. */
  readonly t: (key: MessageKey) => string
  /** Shared settings form for this plugin's Loader entry. */
  readonly form: ConfigForm<FeishuSettingsValue>
}

/** Settings used until the host's section arrives. */
const EMPTY: FeishuSettingsValue = {
  enabled: false,
  appId: '',
  appSecret: '',
  encryptKey: '',
  verificationToken: '',
  chatId: '',
  provider: '',
  model: '',
  reasoningEffort: '',
  routePrompt: '',
  summaryPrompt: '',
  notifyTurnEnd: true,
  notifyError: true,
  notifyQuestion: true,
  notifyApproval: true,
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

/** Props of the shared page head. */
interface HeadProps {
  readonly t: SettingsSectionProps['t']
  /** One line under the title; the page's own copy, already translated. */
  readonly description: string
}

/**
 * Render the page head: title, the mandatory version and author credit, and one
 * line of description.
 *
 * The credit is a style-contract line, rendered verbatim from the dictionary with
 * the version interpolated, so the page always tells the reader which build it is
 * and who wrote it.
 *
 * @param props - translate seat and description.
 * @returns the head element.
 */
function Head({ t, description }: HeadProps): ReactElement {
  return (
    <div className="dfsm-head">
      <div className="dfsm-head-line">
        <h2 className="dfsm-title">{t('title')}</h2>
        <span className="dfsm-credit">{`v${VERSION} | Author: ${AUTHORS}`}</span>
      </div>
      <p className="dfsm-description">{description}</p>
    </div>
  )
}

/**
 * Subscribe to the shared settings form.
 * @param form - the plugin's config form.
 * @returns the current snapshot, re-rendering on each accepted change.
 */
function useSnapshot(form: ConfigForm<FeishuSettingsValue>): ConfigFormSnapshot<FeishuSettingsValue> {
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  // The third argument is the server snapshot: the Harness never renders this
  // page on the host, but a renderer that does (or a test) must not throw for
  // want of it.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Render the settings page.
 * @param props - translate seat and settings form.
 * @returns the page element.
 */
export function SettingsSection({ t, form }: SettingsSectionProps): ReactElement {
  const snapshot = useSnapshot(form)
  const [draft, setDraft] = useState<Partial<FeishuSettingsValue>>({})
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [status, setStatus] = useState<StatusPayload | undefined>(undefined)
  const [models, setModels] = useState<ModelsPayload | undefined>(undefined)
  const [routeText, setRouteText] = useState('')
  const [routeResult, setRouteResult] = useState<RoutePreviewPayload | undefined>(undefined)

  const value = useMemo<FeishuSettingsValue>(
    () => ({ ...EMPTY, ...(snapshot.value ?? {}), ...draft }),
    [snapshot.value, draft],
  )
  const dirty = Object.keys(draft).length > 0
  const readOnly = snapshot.writable === false

  const set = useCallback(<K extends keyof FeishuSettingsValue>(key: K, next: FeishuSettingsValue[K]): void => {
    setDraft((current) => ({ ...current, [key]: next }))
  }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await getStatus()
      setStatus(next)
    } catch (error) {
      setStatus(undefined)
      setNotice({ kind: 'error', text: messageOf(error) })
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => {
      void refreshStatus()
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [refreshStatus])

  useEffect(() => {
    let cancelled = false
    void getModels()
      .then((next) => {
        if (!cancelled) setModels(next)
      })
      .catch(() => {
        if (!cancelled) setModels(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const keys = Object.keys(draft) as (keyof FeishuSettingsValue)[]
    if (keys.length === 0) return
    setBusy('save')
    setNotice(undefined)
    try {
      const ok = await form.mutate(
        keys.map((key) => ({ op: 'set' as const, path: [key], value: draft[key] })),
      )
      if (ok) {
        setDraft({})
        setNotice({ kind: 'ok', text: t('saved') })
        void refreshStatus()
      } else {
        setNotice({ kind: 'error', text: t('saveFailed') })
      }
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(undefined)
    }
  }, [draft, form, refreshStatus, t])

  const resetPrompt = useCallback(
    async (field: 'routePrompt' | 'summaryPrompt'): Promise<void> => {
      setBusy(field)
      try {
        const ok = await form.unset(field)
        setDraft((current) => {
          const next = { ...current }
          delete next[field]
          return next
        })
        setNotice(ok ? { kind: 'ok', text: t('saved') } : { kind: 'error', text: t('saveFailed') })
      } catch (error) {
        setNotice({ kind: 'error', text: messageOf(error) })
      } finally {
        setBusy(undefined)
      }
    },
    [form, t],
  )

  const runTest = useCallback(async (): Promise<void> => {
    setBusy('test')
    try {
      const result = await postTest()
      setNotice({ kind: 'ok', text: `${t('testSent')} (${result.chatId})` })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(undefined)
      void refreshStatus()
    }
  }, [refreshStatus, t])

  const reconnect = useCallback(async (): Promise<void> => {
    setBusy('reconnect')
    try {
      const next = await postReconnect()
      setStatus(next)
      setNotice({ kind: 'ok', text: t('reconnect') })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(undefined)
    }
  }, [t])

  const runRoute = useCallback(async (): Promise<void> => {
    if (routeText.trim() === '') return
    setBusy('route')
    setRouteResult(undefined)
    try {
      setRouteResult(await postRoute(routeText.trim()))
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(undefined)
    }
  }, [routeText])

  if (snapshot.status === 'unavailable') {
    return (
      <div className="dfsm-page">
        <Head t={t} description={t('unavailable')} />
      </div>
    )
  }

  const providerOptions: Option[] = (models?.groups ?? []).map((group) => ({
    value: group.id,
    label: group.name === group.id ? group.id : `${group.name} (${group.id})`,
  }))
  const modelOptions: Option[] =
    models?.groups.find((group) => group.id === value.provider)?.models.map((model) => ({
      value: model.id,
      label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
    })) ?? []

  return (
    <div className="dfsm-page">
      <div className="dfsm-head">
        <div className="dfsm-head-line">
          <h2 className="dfsm-title">{t('title')}</h2>
          <span className="dfsm-credit">{`v${VERSION} | Author: ${AUTHORS}`}</span>
        </div>
        <p className="dfsm-description">{t('description')}</p>
        <div className="dfsm-inline">
          <span className="dfsm-badge">
            <span className="dfsm-dot" data-state={status?.feishu.state ?? 'stopped'} />
            {status === undefined ? t('loading') : `${t('state')}: ${status.feishu.state}`}
          </span>
          <span className="dfsm-badge">{value.enabled ? t('enabled') : `${t('enabled')}: off`}</span>
        </div>
      </div>

      <Group title={t('sectionConnection')} hint={t('connectionHint')}>
        <Row label={t('enabled')} hint={t('enabledHint')}>
          <Toggle
            label={t('enabled')}
            checked={value.enabled}
            disabled={readOnly}
            onChange={(next) => set('enabled', next)}
          />
        </Row>
        <Row label={t('appId')} hint={t('appIdHint')}>
          <TextField
            label={t('appId')}
            value={value.appId}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            disabled={readOnly}
            onChange={(next) => set('appId', next)}
          />
        </Row>
        <Row label={t('appSecret')} hint={t('appSecretHint')}>
          <TextField
            label={t('appSecret')}
            type="password"
            value={value.appSecret}
            placeholder={status?.configured.secrets.appSecret === true ? t('secretSet') : ''}
            disabled={readOnly}
            onChange={(next) => set('appSecret', next)}
          />
        </Row>
        <Row label={t('encryptKey')} hint={t('encryptKeyHint')}>
          <TextField
            label={t('encryptKey')}
            type="password"
            value={value.encryptKey}
            placeholder={status?.configured.secrets.encryptKey === true ? t('secretSet') : ''}
            disabled={readOnly}
            onChange={(next) => set('encryptKey', next)}
          />
        </Row>
        <Row label={t('verificationToken')} hint={t('verificationTokenHint')}>
          <TextField
            label={t('verificationToken')}
            value={value.verificationToken}
            placeholder={status?.configured.secrets.verificationToken === true ? t('secretSet') : ''}
            disabled={readOnly}
            onChange={(next) => set('verificationToken', next)}
          />
        </Row>
        <Row label={t('chatId')} hint={t('chatIdHint')}>
          <TextField
            label={t('chatId')}
            value={value.chatId}
            placeholder="oc_xxxxxxxxxxxxxxxx"
            disabled={readOnly}
            onChange={(next) => set('chatId', next)}
          />
        </Row>
        <Row label={t('language')}>
          <SelectField
            label={t('language')}
            value={value.language}
            disabled={readOnly}
            options={[
              { value: 'auto', label: t('languageAuto') },
              { value: 'en', label: t('languageEn') },
              { value: 'zh', label: t('languageZh') },
            ]}
            onChange={(next) => set('language', next)}
          />
        </Row>
      </Group>

      <Group title={t('sectionModel')} hint={t('modelHint')}>
        <Row label={t('provider')}>
          <SelectField
            label={t('provider')}
            value={value.provider}
            disabled={readOnly}
            options={
              providerOptions.length === 0
                ? [{ value: models?.fallback?.provider ?? '', label: t('modelUnavailable') }]
                : providerOptions
            }
            onChange={(next) => {
              set('provider', next)
              const first = models?.groups.find((group) => group.id === next)?.models[0]
              if (first !== undefined) set('model', first.id)
            }}
          />
        </Row>
        <Row label={t('model')}>
          <SelectField
            label={t('model')}
            value={value.model}
            disabled={readOnly}
            options={
              modelOptions.length === 0
                ? [{ value: models?.fallback?.model ?? '', label: t('fallbackModel') }]
                : modelOptions
            }
            onChange={(next) => set('model', next)}
          />
        </Row>
        <Row label={t('reasoningEffort')} hint={t('reasoningEffortHint')}>
          <TextField
            label={t('reasoningEffort')}
            value={value.reasoningEffort}
            placeholder="high"
            disabled={readOnly}
            onChange={(next) => set('reasoningEffort', next)}
          />
        </Row>
      </Group>

      <Group title={t('sectionPrompts')} hint={t('promptsHint')}>
        <Row label={t('routePrompt')}>
          <TextAreaField
            label={t('routePrompt')}
            value={value.routePrompt}
            rows={12}
            disabled={readOnly}
            onChange={(next) => set('routePrompt', next)}
          />
          <div className="dfsm-inline">
            <ActionButton
              label={t('reset')}
              busy={busy === 'routePrompt'}
              onClick={() => {
                void resetPrompt('routePrompt')
              }}
            />
            <span className="dfsm-hint">
              {value.routePrompt.length} {t('promptChars')}
            </span>
          </div>
        </Row>
        <Row label={t('summaryPrompt')}>
          <TextAreaField
            label={t('summaryPrompt')}
            value={value.summaryPrompt}
            rows={10}
            disabled={readOnly}
            onChange={(next) => set('summaryPrompt', next)}
          />
          <div className="dfsm-inline">
            <ActionButton
              label={t('reset')}
              busy={busy === 'summaryPrompt'}
              onClick={() => {
                void resetPrompt('summaryPrompt')
              }}
            />
            <span className="dfsm-hint">
              {value.summaryPrompt.length} {t('promptChars')}
            </span>
          </div>
        </Row>
      </Group>

      <Group title={t('sectionNotify')} hint={t('notifyHint')}>
        <Row label={t('notifyTurnEnd')}>
          <Toggle
            label={t('notifyTurnEnd')}
            checked={value.notifyTurnEnd}
            disabled={readOnly}
            onChange={(next) => set('notifyTurnEnd', next)}
          />
        </Row>
        <Row label={t('notifyError')}>
          <Toggle
            label={t('notifyError')}
            checked={value.notifyError}
            disabled={readOnly}
            onChange={(next) => set('notifyError', next)}
          />
        </Row>
        <Row label={t('notifyQuestion')}>
          <Toggle
            label={t('notifyQuestion')}
            checked={value.notifyQuestion}
            disabled={readOnly}
            onChange={(next) => set('notifyQuestion', next)}
          />
        </Row>
        <Row label={t('notifyApproval')}>
          <Toggle
            label={t('notifyApproval')}
            checked={value.notifyApproval}
            disabled={readOnly}
            onChange={(next) => set('notifyApproval', next)}
          />
        </Row>
      </Group>

      <Group title={t('sectionPolicy')} hint={t('policyHint')}>
        <Row label={t('allowNewSession')} hint={t('allowNewSessionHint')}>
          <Toggle
            label={t('allowNewSession')}
            checked={value.allowNewSession}
            disabled={readOnly}
            onChange={(next) => set('allowNewSession', next)}
          />
        </Row>
        <Row label={t('inactivityMinutes')} hint={t('inactivityMinutesHint')}>
          <NumberField
            label={t('inactivityMinutes')}
            value={value.inactivityMinutes}
            min={1}
            max={10080}
            disabled={readOnly}
            onChange={(next) => set('inactivityMinutes', next)}
          />
        </Row>
        <Row label={t('routeMaxTokens')} hint={t('routeMaxTokensHint')}>
          <NumberField
            label={t('routeMaxTokens')}
            value={value.routeMaxTokens}
            min={200}
            step={100}
            disabled={readOnly}
            onChange={(next) => set('routeMaxTokens', next)}
          />
        </Row>
        <Row label={t('historyChars')}>
          <NumberField
            label={t('historyChars')}
            value={value.historyChars}
            min={200}
            step={100}
            disabled={readOnly}
            onChange={(next) => set('historyChars', next)}
          />
        </Row>
        <Row label={t('maxSessions')}>
          <NumberField
            label={t('maxSessions')}
            value={value.maxSessions}
            min={1}
            max={50}
            disabled={readOnly}
            onChange={(next) => set('maxSessions', next)}
          />
        </Row>
        <Row label={t('replyTimeoutMinutes')}>
          <NumberField
            label={t('replyTimeoutMinutes')}
            value={value.replyTimeoutMinutes}
            min={1}
            max={240}
            disabled={readOnly}
            onChange={(next) => set('replyTimeoutMinutes', next)}
          />
        </Row>
        <Row label={t('chunkChars')}>
          <NumberField
            label={t('chunkChars')}
            value={value.chunkChars}
            min={500}
            step={100}
            disabled={readOnly}
            onChange={(next) => set('chunkChars', next)}
          />
        </Row>
        <Row label={t('verbose')} hint={t('verboseHint')}>
          <Toggle
            label={t('verbose')}
            checked={value.verbose}
            disabled={readOnly}
            onChange={(next) => set('verbose', next)}
          />
        </Row>
      </Group>

      <Group title={t('sectionStatus')}>
        <div className="dfsm-metrics">
          <span>
            {t('sessions')}: <b>{status?.sessions.total ?? 0}</b>
          </span>
          <span>
            {t('running')}: <b>{status?.sessions.running ?? 0}</b>
          </span>
          <span>
            {t('pending')}: <b>{status?.pending.length ?? 0}</b>
          </span>
          {status === undefined || status.queued === 0 ? null : (
            <span>
              {t('queued')}: <b>{status.queued}</b>
            </span>
          )}
          <span>
            {t('inbound')}: <b>{status?.counters.inbound ?? 0}</b> · {t('outbound')}: <b>{status?.counters.outbound ?? 0}</b> ·{' '}
            {t('notificationsCount')}: <b>{status?.counters.notifications ?? 0}</b> · {t('routed')}:{' '}
            <b>{status?.counters.routed ?? 0}</b> · {t('errors')}: <b>{status?.counters.errors ?? 0}</b>
          </span>
          <span>
            {t('chatId')}: <b>{status?.configured.chatId ?? t('chatUnbound')}</b>
          </span>
          <span>
            {t('model')}: <b>{status?.configured.model === true ? `${value.provider}/${value.model}` : t('notConfigured')}</b>
          </span>
        </div>
        {status?.feishu.detail === undefined ? null : <div className="dfsm-hint">{status.feishu.detail}</div>}

        {status === undefined || status.pending.length === 0 ? null : (
          <ul className="dfsm-pending">
            {status.pending.map((entry) => (
              <li key={`${entry.sessionId}-${String(entry.index)}`}>
                #{entry.index} [{entry.kind}] {entry.sessionLabel}: {entry.summary}
              </li>
            ))}
          </ul>
        )}

        <div className="dfsm-inline">
          <ActionButton label={t('refresh')} onClick={() => void refreshStatus()} />
          <ActionButton label={t('test')} busyLabel={t('testing')} busy={busy === 'test'} onClick={() => void runTest()} />
          <ActionButton label={t('reconnect')} busy={busy === 'reconnect'} onClick={() => void reconnect()} />
          {status === undefined ? null : <span className="dfsm-hint">v{status.version}</span>}
        </div>

        <pre className="dfsm-log">
          {(status?.log ?? []).map((entry, index) => (
            <div key={`${String(entry.at)}-${String(index)}`} className="dfsm-log-line" data-level={entry.level}>
              {new Date(entry.at).toLocaleTimeString()} {entry.text}
            </div>
          ))}
          {status === undefined || status.log.length === 0 ? <div className="dfsm-log-line">{t('noLog')}</div> : null}
        </pre>

        <Row label={t('routePreview')} hint={t('routePreviewHint')}>
          <TextField
            label={t('routePreview')}
            value={routeText}
            placeholder={t('routePlaceholder')}
            onChange={setRouteText}
          />
          <div className="dfsm-inline">
            <ActionButton label={t('routeRun')} busy={busy === 'route'} onClick={() => void runRoute()} />
            {routeResult === undefined ? null : (
              <span className="dfsm-hint">
                {routeResult.candidates.sessions} {t('routeCandidates')}
              </span>
            )}
          </div>
          {routeResult === undefined ? null : (
            <pre className="dfsm-route-result">
              {routeResult.decision === null
                ? `${t('routeNoDecision')}: ${routeResult.error ?? '—'}\n${routeResult.raw ?? ''}`
                : JSON.stringify(routeResult.decision, null, 2)}
            </pre>
          )}
        </Row>
      </Group>

      <div className="dfsm-footer">
        <ActionButton
          label={t('save')}
          busyLabel={t('saving')}
          busy={busy === 'save'}
          primary
          disabled={!dirty || readOnly}
          onClick={() => void save()}
        />
        {notice === undefined ? null : (
          <span className={notice.kind === 'ok' ? 'dfsm-ok' : 'dfsm-error'}>{notice.text}</span>
        )}
        {dirty ? <span className="dfsm-hint">{t('dirty')}</span> : null}
        {snapshot.status === 'loading' ? <span className="dfsm-hint">{t('loading')}</span> : null}
      </div>
    </div>
  )
}

/**
 * Human-readable form of an unknown thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}