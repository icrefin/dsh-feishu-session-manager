/**
 * dsh-feishu-session-manager — host half.
 *
 * Turns one Feishu chat into the interface of every session in this Harness.
 * The host half owns the long-lived Feishu connection, watches the session feed,
 * and calls the two auxiliary models (one summarizes, one routes). The browser
 * half is the settings page that configures it.
 *
 * ## Why the inject list is long
 *
 * A cordis service proxy rebinds `this` to the **caller's** context, so the
 * session controller's cold-prompt path reads `fileUploads`, `attachments`,
 * `fileReferences`, `agentDefaultModel`, `remoteAccess`, `workingDirectory`,
 * `sessionProjections`, `sessionQuery`, `sessions`, `agents`, `llm` and
 * `workspaceRegistry` through *this* plugin's context. Leaving one out makes the
 * first resume of a cold session fail with `cannot get property "<name>" without
 * inject` — an intermittent, cache-shaped failure that appears only when this
 * plugin happens to be the first caller. Every one of these is composed by the
 * web profile this plugin targets.
 *
 * @module dsh-feishu-session-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, PLUGIN_ID } from './config.ts'
import { FeishuBridge } from './bridge.ts'
import { makeRoutes } from './routes.ts'

/** Loader row id; mirrors `cordis.patch.yml` and the package name. */
export const name = PLUGIN_ID

/** The row's Config — and therefore this plugin's settings namespace. */
export { Config }

/**
 * Services required before this plugin may mount.
 *
 * See the module note: the controller's own cold path reaches most of these
 * through this plugin's context.
 */
export const inject = [
  'webServer',
  'llm',
  'sessions',
  'agents',
  'sessionQuery',
  'sessionController',
  'sessionProjections',
  'workspaceRegistry',
  'userQuestions',
  'approval',
  'attachments',
  'fileUploads',
  'fileReferences',
  'agentDefaultModel',
  'remoteAccess',
  'workingDirectory',
]

/**
 * Mount the bridge and its routes.
 * @param ctx - host plugin context.
 * @param config - the row's config, with volatile holders.
 */
export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  const bridge = new FeishuBridge(ctx, config)

  ctx.effect(() => {
    const disposers = makeRoutes(ctx, bridge).map((route) => ctx.webServer.register(route))
    ctx.logger.info('[dsh-feishu-session-manager] routes mounted')
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, `${PLUGIN_ID}: routes`)

  bridge.mount((callback, label) => {
    ctx.effect(callback, label)
  })

  ctx.logger.info('[dsh-feishu-session-manager] bridge mounted; Feishu connects when enabled and configured')
}
