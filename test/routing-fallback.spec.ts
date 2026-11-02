/**
 * The routing failure path, end to end.
 *
 * The reported failure was real: a model returned something that was not JSON, and
 * the bridge replied "I could not decide where this belongs" — a dead end for a
 * message that clearly asked for new work in a known workspace. These cases drive
 * the bridge's inbound seam with a stubbed harness and prove that the message is
 * still routed, and that the user is told why when the fallback decided.
 *
 * @module dsh-feishu-session-manager/test/routing-fallback
 */

import { describe, expect, it } from 'vitest'
import { FeishuBridge } from '../src/bridge.ts'
import { chooseFallbackRoute } from '../src/llm/fallback.ts'
import type { Catalog } from '../src/session/catalog.ts'
import type { InboundMessage } from '../src/feishu/client.ts'

/** One session-create call recorded from the fake controller. */
interface CreateCall {
  readonly workspaceId: string
}

/** The model answer the fake LLM service yields. */
let modelAnswer = ''

/** Prompts the fake LLM service was called with. */
const prompts: { system: string; user: string }[] = []

/**
 * Build a stubbed host context for one bridge.
 * @param creates - receives each `sessionController.create` request.
 * @returns the context.
 */
function fakeContext(creates: CreateCall[]): Record<string, unknown> {
  const workspace = { id: 'ws-1', title: 'dsh-plugins', path: '/work/dsh-plugins', sessionIds: ['s-1'] }
  const records = [{ header: { id: 's-1', createdAt: 1, cwd: '/work/dsh-plugins' } }]
  const surface = {
    session: { id: 's-1' },
    inheritedEventCount: 0,
    capturedThroughSeq: 2,
    events: [
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'the feishu plugin' }] } },
      { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    ],
  }
  return {
    effect: (callback: () => (() => void) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposer()
    },
    on: () => () => {},
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    get: (name: string) => {
      if (name === 'workspaceRegistry') return { list: () => [workspace], get: () => workspace, archivedSessionIds: [] }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      if (name === 'sessionProjections') return { stateOf: () => undefined }
      return undefined
    },
    webServer: { register: () => () => {} },
    sessionQuery: {
      listSessions: async () => records,
      readSurface: async () => surface,
      readTitleSnapshots: async () => [
        { sessionId: 's-1', status: 'fulfilled', value: { title: { title: 'Feishu plugin' } } },
      ],
    },
    workspaceRegistry: { list: () => [workspace], get: () => workspace, archivedSessionIds: [] },
    sessionController: {
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [], failures: [] }),
      create: async (request: { workspaceId?: string }) => {
        creates.push({ workspaceId: request.workspaceId ?? '' })
        return { sessionId: 's-new' }
      },
      prompt: async () => ({ accepted: true }),
    },
    llm: {
      async *stream(options: { system: string; messages: { content: { text: string }[] }[] }) {
        prompts.push({ system: options.system, user: options.messages[0]?.content[0]?.text ?? '' })
        yield { type: 'text-delta', index: 0, text: modelAnswer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

/** Config that routes through the stub without opening a socket. */
const CONFIG = {
  enabled: true,
  appId: '',
  appSecret: '',
  provider: 'p',
  model: 'm',
  chatId: 'oc_chat',
  allowNewSession: true,
}

/** One inbound message as the transport would normalize it. */
const MESSAGE: InboundMessage = {
  chatId: 'oc_chat',
  chatType: 'p2p',
  messageId: 'om_1',
  text: 'create a new plugin to auto rename the session based on the tasks in the session.',
  messageType: 'text',
}

/**
 * Run one inbound message through a fresh bridge.
 * @param answer - what the model returns.
 * @returns the recorded creates, prompts and log lines.
 */
async function run(answer: string): Promise<{ creates: CreateCall[]; log: string[] }> {
  modelAnswer = answer
  prompts.length = 0
  const creates: CreateCall[] = []
  const bridge = new FeishuBridge(fakeContext(creates) as never, CONFIG)
  await bridge.ingest(MESSAGE)
  return { creates, log: bridge.logEntries().map((entry) => entry.text) }
}

describe('a model answer that is not JSON', () => {
  it('still creates the session the message asked for, and says why', async () => {
    const { creates, log } = await run('I think this should be a new session in dsh-plugins.')
    expect(creates).toHaveLength(1)
    expect(creates[0]?.workspaceId).toBe('ws-1')
    expect(log.some((line) => line.includes('routing fell back'))).toBe(true)
  })

  it('gives up asking the human only when there is nothing to fall back to', async () => {
    const { creates, log } = await run('prose, prose, prose')
    // The stub catalog always has one session, so the fallback still routes.
    expect(creates).toHaveLength(1)
    expect(log.some((line) => line.includes('routing fell back'))).toBe(true)
  })

  it('asks twice before falling back', async () => {
    await run('not json at all')
    expect(prompts.length).toBe(2)
    // The retry restates the contract inside the user message.
    expect(prompts[1]?.user).toContain('Reply with ONE JSON object')
  })

  it('does not retry when the first answer parses', async () => {
    const { creates, log } = await run(
      '{"action":"new_session","workspaceId":"ws-1","prompt":"create the plugin","reason":"new work","confidence":0.9}',
    )
    expect(creates).toEqual([{ workspaceId: 'ws-1' }])
    expect(prompts.length).toBe(1)
    expect(log.some((line) => line.includes('routing fell back'))).toBe(false)
  })

  it('recovers a truncated JSON answer instead of retrying', async () => {
    const { creates } = await run(
      '{"action":"new_session","workspaceId":"ws-1","prompt":"create the plugin","reason":"new work","conf',
    )
    expect(creates).toEqual([{ workspaceId: 'ws-1' }])
    expect(prompts.length).toBe(1)
  })
})

describe('a blank policy prompt', () => {
  it('falls back to the shipped policy instead of sending an empty system slot', async () => {
    const { creates } = await run('{"action":"new_session","workspaceId":"ws-1","prompt":"go"}')
    // The stub config sets no prompts, so the shipped policy must be what the
    // model saw — a blank one makes the model answer with no JSON at all.
    expect(prompts[0]?.system.length).toBeGreaterThan(1000)
    expect(prompts[0]?.system).toContain('router of a DeepSeek Harness installation')
    expect(creates).toHaveLength(1)
  })
})

describe('chooseFallbackRoute', () => {
  const catalog: Catalog = {
    readAt: 0,
    workspaces: [
      { id: 'ws-a', title: 'dsh-plugins', path: '/work/dsh-plugins', sessionIds: ['s-1'] },
      { id: 'ws-b', title: 'website', path: '/work/site', sessionIds: [] },
    ],
    sessions: [
      {
        id: 's-1',
        title: 'Feishu plugin',
        cwd: '/work/dsh-plugins',
        workspaceId: 'ws-a',
        workspaceTitle: 'dsh-plugins',
        workspacePath: '/work/dsh-plugins',
        updatedAt: 100,
        inactiveMinutes: 1,
        running: false,
        waiting: false,
        contextTokens: 1000,
        contextWindow: 200000,
        contextPercent: 1,
        digest: [],
        digestText: '',
        lastUserText: 'feishu',
      },
    ],
  }

  it('prefers the workspace the message names', () => {
    const decision = chooseFallbackRoute(catalog, { message: 'fix the website build', allowNewSession: true })
    expect(decision.action).toBe('new_session')
    expect(decision.workspaceId).toBe('ws-b')
  })

  it('otherwise starts in the workspace with the newest activity', () => {
    const decision = chooseFallbackRoute(catalog, { message: 'add a new plugin', allowNewSession: true })
    expect(decision.workspaceId).toBe('ws-a')
    expect(decision.prompt).toBe('add a new plugin')
  })

  it('continues the newest session when creating is disabled', () => {
    const decision = chooseFallbackRoute(catalog, { message: 'carry on', allowNewSession: false })
    expect(decision.action).toBe('continue')
    expect(decision.sessionId).toBe('s-1')
  })

  it('asks when the installation has nothing at all', () => {
    const decision = chooseFallbackRoute(
      { readAt: 0, workspaces: [], sessions: [] },
      { message: 'hello', allowNewSession: true },
    )
    expect(decision.action).toBe('reply')
    expect(decision.reply).toContain('/sessions')
  })
})