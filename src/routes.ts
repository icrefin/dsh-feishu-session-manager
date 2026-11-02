/**
 * The `/api/dsh-feishu-session-manager` route family.
 *
 * These routes serve the settings page and nothing else: read status, list
 * models, send one test message, force a reconnect, and dry-run the router.
 * Delivery itself never travels over HTTP — the bridge is driven by Harness
 * events and by the Feishu socket.
 *
 * Every route carries a loopback-only fence and a method check: named routes are
 * matched before the authenticated SPA fallback and are not covered by the launch
 * token, so a state-mutating route must refuse anything that did not come from
 * this machine. The request body is bounded for the same reason.
 *
 * @module dsh-feishu-session-manager/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { FeishuBridge } from './bridge.ts'
import { readModelCatalog } from './llm/call.ts'
import {
  API,
  type ErrorPayload,
  type ModelsPayload,
  type RoutePreviewPayload,
  type StatusPayload,
  type TestPayload,
  type TestRequest,
} from './protocol.ts'

/** Largest accepted request body; every body this API takes is a short string. */
const BODY_LIMIT = 64 * 1024

/** Write one JSON response body. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Write one JSON error body. */
function writeError(res: ServerResponse, status: number, message: string): void {
  const body: ErrorPayload = { error: message }
  writeJson(res, status, body)
}

/** Whether the request arrived over the loopback interface. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read and parse a bounded JSON body.
 * @param req - the request.
 * @returns the parsed value, or `null` when the body is absent or not JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > BODY_LIMIT) return null
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * Build every route of the plugin's API family.
 * @param ctx - host context, used for the model catalog.
 * @param bridge - the running bridge.
 * @returns exact-path routes to register on `ctx.webServer`.
 */
export function makeRoutes(ctx: Context, bridge: FeishuBridge): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: API.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const payload: StatusPayload = await bridge.status()
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact',
      path: API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const catalog = await readModelCatalog(ctx)
        const payload: ModelsPayload = {
          groups: catalog.groups,
          fallback: catalog.fallback,
          failures: catalog.failures,
        }
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact',
      path: API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as TestRequest | null
        if (body === null) {
          writeError(res, 400, 'body must be JSON')
          return
        }
        const chatId = (await bridge.status()).configured.chatId
        if (chatId === null) {
          writeError(res, 409, 'no chat is bound yet: send any message to the bot, or set a chat id')
          return
        }
        const text = body.text?.trim() ?? ''
        const message =
          text === ''
            ? 'Feishu Session Manager test message. If you can read this, the bridge can reach this chat.'
            : text
        const sent = await bridge.send(message, chatId)
        const payload: TestPayload = {
          sent,
          chatId,
          detail: sent ? 'Feishu accepted the message.' : 'Sending failed; read the activity log for the reason.',
        }
        writeJson(res, sent ? 200 : 502, payload)
      },
    },
    {
      kind: 'exact',
      path: API.reconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        bridge.forceReconnect()
        const payload: StatusPayload = await bridge.status()
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact',
      path: API.route,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as { text?: unknown } | null
        if (body === null || typeof body.text !== 'string' || body.text.trim() === '') {
          writeError(res, 400, 'body must be {"text": "..."}')
          return
        }
        const preview: RoutePreviewPayload = await bridge.previewRoute(body.text.trim())
        writeJson(res, 200, preview)
      },
    },
  ]
}

/**
 * Apply the loopback and method fence.
 * @param req - the request.
 * @param res - the response, written on refusal.
 * @param method - the only accepted method.
 * @returns true when the handler may run.
 */
function guard(req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST'): boolean {
  if (!isLoopbackRequest(req)) {
    writeError(res, 403, 'forbidden: loopback-only')
    return false
  }
  if (req.method !== method) {
    writeError(res, 405, `method not allowed: ${req.method ?? ''}`)
    return false
  }
  return true
}