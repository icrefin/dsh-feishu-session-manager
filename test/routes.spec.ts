/**
 * The plugin's HTTP family.
 *
 * Two layers are exercised: the real handlers over a real loopback server, which
 * proves the payloads and status codes, and direct handler calls with a
 * non-loopback socket, which is the only way to prove the fence without a second
 * network namespace.
 *
 * @module dsh-feishu-session-manager/test/routes
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FeishuBridge } from '../src/bridge.ts'
import {
  API,
  type ErrorPayload,
  type ModelsPayload,
  type RoutePreviewPayload,
  type StatusPayload,
  type TestPayload,
} from '../src/protocol.ts'
import { makeRoutes } from '../src/routes.ts'

/** Status the fake bridge reports. */
function statusPayload(chatId: string | null = 'oc_chat'): StatusPayload {
  return {
    id: 'dsh-feishu-session-manager',
    version: '0.1.0',
    pid: process.pid,
    enabled: true,
    configured: { credentials: true, model: true, secrets: { appSecret: true, encryptKey: false, verificationToken: false }, chatId },
    feishu: { state: 'connected', since: 0 },
    counters: { inbound: 1, outbound: 2, notifications: 3, routed: 4, errors: 0 },
    pending: [],
    queued: 0,
    sessions: { total: 5, running: 1, waiting: 0 },
    services: { llm: true },
    log: [{ at: 0, level: 'info', text: 'up' }],
  }
}

/** Sent messages captured by the fake bridge. */
const sent: { text: string; chatId?: string }[] = []

/** The bridge stand-in: records what the routes ask of it. */
const bridge = {
  status: async (): Promise<StatusPayload> =>
    statusPayload(globalThis.__chatId === undefined ? 'oc_chat' : globalThis.__chatId),
  send: async (text: string, chatId?: string): Promise<boolean> => {
    sent.push({ text, ...(chatId === undefined ? {} : { chatId }) })
    return true
  },
  forceReconnect: (): void => {
    globalThis.__reconnected = true
  },
  previewRoute: async (text: string): Promise<RoutePreviewPayload> => ({
    decision: {
      action: 'continue',
      sessionId: 's-1',
      prompt: text,
      reason: 'same topic',
      confidence: 0.8,
    },
    candidates: { sessions: 2, workspaces: 1 },
  }),
} as unknown as FeishuBridge

declare global {
  // eslint-disable-next-line no-var
  var __chatId: string | null | undefined
  // eslint-disable-next-line no-var
  var __reconnected: boolean | undefined
}

/** Host context the routes read: only the model catalog. */
const ctx = {
  sessionController: {
    modelCatalog: async (): Promise<unknown> => ({
      default: { provider: 'deepseek', model: 'chat' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
      failures: [{ id: 'broken', name: 'Broken', message: 'no credential' }],
    }),
  },
} as unknown as Context

const routes = makeRoutes(ctx, bridge)

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server bound no TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('GET status', () => {
  it('reports the bridge state with no caching', async () => {
    const response = await fetch(`${origin}${API.status}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const payload = (await response.json()) as StatusPayload
    expect(payload.id).toBe('dsh-feishu-session-manager')
    expect(payload.feishu.state).toBe('connected')
    expect(payload.counters.routed).toBe(4)
  })

  it('rejects a method the route does not own', async () => {
    const response = await fetch(`${origin}${API.status}`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(((await response.json()) as ErrorPayload).error).toContain('method not allowed')
  })
})

describe('GET models', () => {
  it('serves the groups, the fallback and the failures', async () => {
    const response = await fetch(`${origin}${API.models}`)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as ModelsPayload
    expect(payload.groups[0]?.models[0]?.id).toBe('chat')
    expect(payload.fallback?.provider).toBe('deepseek')
    expect(payload.failures[0]?.id).toBe('broken')
  })
})

describe('POST test', () => {
  it('sends the probe to the bound chat', async () => {
    sent.length = 0
    globalThis.__chatId = 'oc_chat'
    const response = await fetch(`${origin}${API.test}`, { method: 'POST' })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as TestPayload
    expect(payload.sent).toBe(true)
    expect(payload.chatId).toBe('oc_chat')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('test message')
  })

  it('sends the caller text when one is given', async () => {
    sent.length = 0
    globalThis.__chatId = 'oc_chat'
    await fetch(`${origin}${API.test}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'custom probe' }),
    })
    expect(sent[0]?.text).toBe('custom probe')
  })

  it('refuses when no chat is bound', async () => {
    globalThis.__chatId = null
    const response = await fetch(`${origin}${API.test}`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorPayload).error).toContain('no chat is bound')
  })

  it('rejects a body that is not JSON', async () => {
    globalThis.__chatId = 'oc_chat'
    const response = await fetch(`${origin}${API.test}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })
})

describe('POST reconnect', () => {
  it('asks the bridge to reopen the socket and returns fresh status', async () => {
    globalThis.__reconnected = false
    const response = await fetch(`${origin}${API.reconnect}`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(globalThis.__reconnected).toBe(true)
  })
})

describe('POST route', () => {
  it('returns the dry-run decision', async () => {
    const response = await fetch(`${origin}${API.route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'fix the build' }),
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as RoutePreviewPayload
    expect(payload.decision?.sessionId).toBe('s-1')
    expect(payload.decision?.prompt).toBe('fix the build')
    expect(payload.candidates.sessions).toBe(2)
  })

  it('rejects a body without text', async () => {
    const response = await fetch(`${origin}${API.route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
  })
})

describe('the loopback fence', () => {
  it('refuses a request that did not arrive over loopback', async () => {
    const writes: string[] = []
    const res = {
      writeHead() {},
      end(text: string) {
        writes.push(text)
      },
    }
    const req = { method: 'GET', socket: { remoteAddress: '203.0.113.9' } }
    const route = routes.find((candidate) => candidate.path === API.status)
    expect(route).toBeDefined()
    await route?.handler(req as never, res as never)
    expect(writes[0]).toContain('forbidden: loopback-only')
  })

  it('accepts the IPv6 loopback spelling', async () => {
    let body = ''
    const res = {
      writeHead() {},
      end(text: string) {
        body = text
      },
    }
    const req = { method: 'GET', socket: { remoteAddress: '::1' } }
    const route = routes.find((candidate) => candidate.path === API.status)
    await route?.handler(req as never, res as never)
    expect(body).toContain('"id"')
  })
})