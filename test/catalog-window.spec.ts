/**
 * The context window the router is shown comes from the session, not the plugin.
 *
 * A fixed budget in the settings is a lie about a fact the Harness already knows:
 * every session runs under one model, and that model has a context capacity
 * reported by the route that served it. These cases pin the three sources and the
 * honest `0` when none of them can answer.
 *
 * @module dsh-feishu-session-manager/test/catalog-window
 */

import { describe, expect, it } from 'vitest'
import { readCatalog } from '../src/session/catalog.ts'

/** What the fake projections report for the one live session. */
let pressure: unknown
/** What the fake projections report for the model selection. */
let selection: unknown
/** Model windows the fake LLM service resolves. */
let windows: Record<string, number>
/** The deployment default the fake controller reports. */
let fallbackWindow: number
/** The deployment default model id the fake controller reports. */
let fallbackModel = 'base-model'

/**
 * Build the host context a catalog read needs.
 * @param live - whether the session exists as a live object.
 * @returns the fake context.
 */
function fakeContext(live: boolean): Record<string, unknown> {
  const session = { id: 's-1' }
  const workspace = { id: 'ws-1', title: 'dsh-plugins', path: '/work/dsh-plugins', sessionIds: ['s-1'] }
  return {
    get: (name: string) => {
      if (name === 'workspaceRegistry') {
        return { list: () => [workspace], get: () => workspace, archivedSessionIds: [] }
      }
      if (name === 'sessions') return { get: live ? () => session : () => undefined, list: () => (live ? [session] : []) }
      if (name === 'sessionProjections') {
        return {
          stateOf: (_session: unknown, key: string) => {
            if (key === 'contextPressure') return pressure
            if (key === 'modelSelection') return selection
            return undefined
          },
        }
      }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    sessionQuery: {
      listSessions: async () => [{ header: { id: 's-1', createdAt: 1000, cwd: '/work/dsh-plugins' } }],
      readSurface: async () => ({
        session: { id: 's-1' },
        inheritedEventCount: 0,
        capturedThroughSeq: 1,
        events: [{ type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: 'hello' }] } }],
      }),
      readTitleSnapshots: async () => [{ sessionId: 's-1', status: 'fulfilled', value: { title: { title: 'Task' } } }],
    },
    workspaceRegistry: { list: () => [workspace], get: () => workspace, archivedSessionIds: [] },
    llm: {
      resolveModelInfo: async (provider: string, model: string) => {
        const window = windows[`${provider}/${model}`] ?? fallbackWindow
        return window > 0 ? { contextWindow: window } : {}
      },
    },
    sessionController: {
      modelCatalog: async () => ({ default: { provider: 'base', model: fallbackModel }, groups: [], failures: [] }),
    },
  } as unknown as Record<string, unknown>
}

/**
 * Read one catalog entry.
 * @param live - whether the session is live.
 * @returns the single session view.
 */
async function read(live = true): Promise<{ contextTokens: number; contextWindow: number; contextPercent: number }> {
  const catalog = await readCatalog(fakeContext(live) as never, { maxSessions: 5, historyChars: 400 })
  const session = catalog.sessions[0]
  if (session === undefined) throw new Error('the catalog returned no session')
  return {
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow,
    contextPercent: session.contextPercent,
  }
}

describe('the session context window', () => {
  it('uses the capacity the serving route reported', async () => {
    pressure = { projectedTokens: 130000, contextWindow: 200000 }
    selection = { next: null, lastUsed: null }
    windows = {}
    fallbackWindow = 0
    const view = await read()
    expect(view.contextWindow).toBe(200000)
    expect(view.contextTokens).toBe(130000)
    expect(view.contextPercent).toBe(65)
  })

  it('falls back to the session model selection when the route has not reported one', async () => {
    pressure = { projectedTokens: 32000 }
    selection = { next: { provider: 'acme', model: 'long' }, lastUsed: null }
    windows = { 'acme/long': 1000000 }
    fallbackWindow = 0
    const view = await read()
    expect(view.contextWindow).toBe(1000000)
    expect(view.contextPercent).toBe(3)
  })

  it('falls back to the deployment default for a cold session', async () => {
    pressure = undefined
    selection = undefined
    windows = { 'base/base-model': 128000 }
    fallbackWindow = 128000
    const view = await read(false)
    expect(view.contextWindow).toBe(128000)
  })

  it('reports unknown pressure honestly when no source can answer', async () => {
    pressure = { projectedTokens: 1234 }
    selection = { next: null, lastUsed: null }
    windows = {}
    fallbackWindow = 0
    // A model the cache has never seen, so this case really resolves to nothing.
    fallbackModel = 'unresolvable-model'
    const view = await read()
    expect(view.contextWindow).toBe(0)
    expect(view.contextPercent).toBe(0)
  })
})