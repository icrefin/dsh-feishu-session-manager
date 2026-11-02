/**
 * The host half mounted against a stubbed harness.
 *
 * This is the closest check to the real thing that does not need a running
 * Harness: `apply` registers its routes and listeners through the same cordis
 * surface, a `turn/end` event travels through the transcript read into the
 * summarizing model call, and the composed message is the one the chat would
 * receive. A typo in an event name or a missing service read shows up here.
 *
 * Stubs are deliberately minimal and typed as `never` at the boundary: the point
 * is the plugin's own wiring, not the harness's services.
 *
 * @module dsh-feishu-session-manager/test/host-mount
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { API } from '../src/protocol.ts'
import type { FeishuSettingsValue } from '../src/client/plugin.ts'

/** One captured `llm.stream` request. */
interface CapturedCall {
  system: string
  messages: { role: string; content: { type: string; text: string }[] }[]
  provider: string
  model: string
}

/** One registered route. */
interface RegisteredRoute {
  path: string
}

/**
 * Build a stubbed host context.
 * @param calls - where model calls are recorded.
 * @returns the context plus the pieces a test asserts on.
 */
function fakeContext(calls: CapturedCall[]): {
  ctx: Record<string, unknown>
  routes: RegisteredRoute[]
  listeners: Map<string, ((...args: never[]) => unknown)[]>
  disposers: (() => void)[]
} {
  const routes: RegisteredRoute[] = []
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const disposers: (() => void)[] = []

  const workspace = { id: 'ws-1', title: 'dsh-plugins', path: '/work/dsh-plugins', sessionIds: ['s-1'] }
  const records = [{ header: { id: 's-1', createdAt: Date.now() - 60000, cwd: '/work/dsh-plugins' } }]
  const surface = {
    session: { id: 's-1' },
    inheritedEventCount: 0,
    capturedThroughSeq: 3,
    events: [
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'fix the build' }] } },
      { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'the build is fixed' }] } } },
    ],
  }

  const sessionQuery = {
    listSessions: async () => records,
    readSurface: async () => surface,
    readTitleSnapshots: async () => [
      { sessionId: 's-1', status: 'fulfilled', value: { title: { title: 'Fix the build' } } },
    ],
  }
  const workspaceRegistry = {
    list: () => [workspace],
    get: (id: string) => (id === 'ws-1' ? workspace : undefined),
    archivedSessionIds: [] as string[],
  }

  const ctx: Record<string, unknown> = {
    effect: (callback: () => (() => void) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => {}
    },
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    get: (name: string) => {
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionProjections') return { stateOf: () => undefined }
      return undefined
    },
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return () => {}
      },
    },
    sessionQuery,
    workspaceRegistry,
    sessionController: {
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [], failures: [] }),
      create: async () => ({ sessionId: 's-new' }),
      prompt: async () => ({ accepted: true }),
    },
    llm: {
      async *stream(options: CapturedCall) {
        calls.push(options)
        yield { type: 'text-delta', index: 0, text: 'Workspace: dsh-plugins | Session: Fix the build\n' }
        yield { type: 'text-delta', index: 0, text: 'The build now passes.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { ctx, routes, listeners, disposers }
}

/** Config that is enabled but has no credentials, so no socket is attempted. */
const CONFIG: Partial<FeishuSettingsValue> = {
  enabled: true,
  appId: '',
  appSecret: '',
  provider: 'p',
  model: 'm',
  chatId: 'oc_chat',
}

/**
 * Let the fire-and-forget summary settle.
 * @param check - predicate that becomes true when the work finished.
 */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the asynchronous work never settled')
}

describe('apply', () => {
  it('registers every route of its API family and nothing else', () => {
    const { ctx, routes } = fakeContext([])
    apply(ctx as never, { ...CONFIG })
    expect(routes.map((route) => route.path).sort()).toEqual(Object.values(API).sort())
  })

  it('registers the four listeners it acts on', () => {
    const { ctx, listeners } = fakeContext([])
    apply(ctx as never, { ...CONFIG })
    expect([...listeners.keys()].sort()).toEqual([
      'agent/error',
      'approval/request',
      'session/event',
      'user-questions/request',
    ])
  })

  it('summarizes a finished turn through the model and composes one push', async () => {
    const calls: CapturedCall[] = []
    const { ctx, listeners } = fakeContext(calls)
    apply(ctx as never, { ...CONFIG })
    const sessionListeners = listeners.get('session/event') ?? []
    expect(sessionListeners).toHaveLength(1)
    const listener = sessionListeners[0]
    expect(listener).toBeDefined()
    listener?.(
      { header: { id: 's-1', cwd: '/work/dsh-plugins' }, id: 's-1' } as never,
      { type: 'turn/end', seq: 3 } as never,
    )
    await until(() => calls.length === 1)
    expect(calls[0]?.provider).toBe('p')
    expect(calls[0]?.system).toContain('You summarize a DeepSeek Harness session')
    const text = calls[0]?.messages[0]?.content[0]?.text ?? ''
    const user = JSON.parse(text) as Record<string, unknown>
    expect(user.workspace).toBe('dsh-plugins')
    expect(user.session).toBe('Fix the build')
    expect(String(user.transcript)).toContain('the build is fixed')
  })

  it('ignores a child session and a repeated turn-end', async () => {
    const calls: CapturedCall[] = []
    const { ctx, listeners } = fakeContext(calls)
    apply(ctx as never, { ...CONFIG })
    const listener = (listeners.get('session/event') ?? [])[0]
    listener?.(
      { header: { id: 's-1', cwd: '/p', origin: 'subagent' }, id: 's-1' } as never,
      { type: 'turn/end', seq: 1 } as never,
    )
    listener?.(
      { header: { id: 's-1', cwd: '/p' }, id: 's-1' } as never,
      { type: 'turn/end', seq: 3 } as never,
    )
    listener?.(
      { header: { id: 's-1', cwd: '/p' }, id: 's-1' } as never,
      { type: 'turn/end', seq: 3 } as never,
    )
    await until(() => calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1)
  })

  it('tears the registrations down through the effects it owns', () => {
    const { ctx, disposers } = fakeContext([])
    apply(ctx as never, { ...CONFIG })
    expect(disposers.length).toBeGreaterThanOrEqual(2)
    for (const dispose of disposers) {
      expect(() => {
        dispose()
      }).not.toThrow()
    }
  })
})