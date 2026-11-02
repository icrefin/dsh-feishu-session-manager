/**
 * The two model calls' contracts: what the router is shown, and what the plugin
 * does with what comes back.
 *
 * The routing answer is the one place a model is trusted with an identity, so
 * every refusal path is exercised here: an id that was not offered, an action
 * that is disabled, a body that is not JSON at all.
 *
 * @module dsh-feishu-session-manager/test/prompts
 */

import { describe, expect, it } from 'vitest'
import type { Catalog } from '../src/session/catalog.ts'
import {
  buildRouteUserMessage,
  buildSummaryUserMessage,
  composeNewSessionPrompt,
  extractJsonObject,
  normalizeSummary,
  parseRouteDecision,
  withLanguageDirective,
} from '../src/llm/prompts.ts'

/** One catalog with two sessions and one workspace. */
const catalog: Catalog = {
  readAt: 1762000000000,
  workspaces: [{ id: 'ws-1', title: 'dsh-plugins', path: '/work/dsh-plugins', sessionIds: ['s-1', 's-2'] }],
  sessions: [
    {
      id: 's-1',
      title: 'Fix the build',
      cwd: '/work/dsh-plugins',
      workspaceId: 'ws-1',
      workspaceTitle: 'dsh-plugins',
      workspacePath: '/work/dsh-plugins',
      updatedAt: 1761999000000,
      inactiveMinutes: 16,
      running: false,
      waiting: false,
      contextTokens: 12000,
      contextWindow: 200000,
      contextPercent: 6,
      digest: [],
      digestText: 'user: fix the build\nassistant: done',
      lastUserText: 'fix the build',
    },
    {
      id: 's-2',
      title: 'Write release notes',
      cwd: '/work/dsh-plugins',
      workspaceId: 'ws-1',
      workspaceTitle: 'dsh-plugins',
      workspacePath: '/work/dsh-plugins',
      updatedAt: 1761900000000,
      inactiveMinutes: 1000,
      running: false,
      waiting: true,
      contextTokens: 100000,
      contextWindow: 200000,
      contextPercent: 50,
      digest: [],
      digestText: 'user: release notes\nassistant: draft',
      lastUserText: 'release notes',
    },
  ],
}

const context = {
  sessionIds: new Set(['s-1', 's-2']),
  workspaceIds: new Set(['ws-1']),
  message: 'please fix the failing test',
  allowNewSession: true,
}

describe('buildRouteUserMessage', () => {
  it('carries the workspaces, the candidates and the message as one JSON document', () => {
    const parsed = JSON.parse(buildRouteUserMessage(catalog, 'hello', 1762000000000)) as Record<string, unknown>
    expect(parsed.message).toBe('hello')
    expect(parsed.now).toBe('2025-11-01T12:26:40.000Z')
    const workspaces = parsed.workspaces as { id: string; path: string }[]
    expect(workspaces).toEqual([{ id: 'ws-1', title: 'dsh-plugins', path: '/work/dsh-plugins' }])
    const sessions = parsed.sessions as {
      id: string
      inactiveMinutes: number
      waiting: boolean
      transcript: string
      contextTokens: number
      contextWindow: number | null
      contextPercent: number | null
    }[]
    expect(sessions).toHaveLength(2)
    expect(sessions[1]?.waiting).toBe(true)
    expect(sessions[1]?.transcript).toContain('release notes')
    // The window is the session's own model capacity, reported as a percentage so
    // the router does not have to divide.
    expect(sessions[0]?.contextWindow).toBe(200000)
    expect(sessions[0]?.contextPercent).toBe(6)
    expect(sessions[1]?.contextPercent).toBe(50)
  })
})

describe('a session with an unknown window', () => {
  it('reports null rather than a made-up capacity', () => {
    const unknown: Catalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) => ({ ...session, contextWindow: 0, contextPercent: 0 })),
    }
    const parsed = JSON.parse(buildRouteUserMessage(unknown, 'hello', 1762000000000)) as {
      sessions: { contextWindow: unknown; contextPercent: unknown }[]
    }
    expect(parsed.sessions[0]?.contextWindow).toBeNull()
    expect(parsed.sessions[0]?.contextPercent).toBeNull()
  })
})

describe('buildSummaryUserMessage', () => {
  it('names the identity and the event', () => {
    const parsed = JSON.parse(
      buildSummaryUserMessage({
        identity: { workspace: 'ws', workspacePath: '/p', session: 'Task', sessionId: 's-1' },
        event: 'turn-failed',
        failureCode: 'RATE_LIMIT',
        transcript: 'user: hi',
      }),
    ) as Record<string, unknown>
    expect(parsed.workspace).toBe('ws')
    expect(parsed.event).toBe('turn-failed')
    expect(parsed.failureCode).toBe('RATE_LIMIT')
    expect(parsed.transcript).toBe('user: hi')
  })
})

describe('parseRouteDecision', () => {
  it('accepts a continue that names an offered session', () => {
    const parsed = parseRouteDecision(
      '{"action":"continue","sessionId":"s-1","prompt":"fix it","reason":"same topic","confidence":0.9}',
      context,
    )
    expect(parsed.error).toBeUndefined()
    expect(parsed.decision?.action).toBe('continue')
    expect(parsed.decision?.sessionId).toBe('s-1')
    expect(parsed.decision?.prompt).toBe('fix it')
  })

  it('refuses a session id that was never offered', () => {
    const parsed = parseRouteDecision('{"action":"continue","sessionId":"other"}', context)
    expect(parsed.decision).toBeUndefined()
    expect(parsed.error).toContain('unknown sessionId')
  })

  it('refuses a session id on a new-session action', () => {
    const parsed = parseRouteDecision('{"action":"new_session","workspaceId":"missing"}', context)
    expect(parsed.error).toContain('unknown workspaceId')
  })

  it('accepts a new session in an offered workspace and falls back to the human text', () => {
    const parsed = parseRouteDecision('{"action":"new_session","workspaceId":"ws-1"}', context)
    expect(parsed.decision?.action).toBe('new_session')
    expect(parsed.decision?.prompt).toBe('please fix the failing test')
  })

  it('requires distilled context for new_session_with_context', () => {
    const missing = parseRouteDecision('{"action":"new_session_with_context","workspaceId":"ws-1"}', context)
    expect(missing.error).toContain('without context')
    const present = parseRouteDecision(
      '{"action":"new_session_with_context","workspaceId":"ws-1","context":"the lock lives in build.ts","prompt":"continue"}',
      context,
    )
    expect(present.decision?.context).toBe('the lock lives in build.ts')
  })

  it('refuses to create a session when the setting disables it', () => {
    const parsed = parseRouteDecision('{"action":"new_session","workspaceId":"ws-1"}', {
      ...context,
      allowNewSession: false,
    })
    expect(parsed.decision).toBeUndefined()
    expect(parsed.error).toContain('disabled')
  })

  it('accepts reply and ignore without any target', () => {
    expect(parseRouteDecision('{"action":"reply","reply":"which one?"}', context).decision?.reply).toBe('which one?')
    expect(parseRouteDecision('{"action":"ignore"}', context).decision?.action).toBe('ignore')
  })

  it('reads JSON out of a fenced answer', () => {
    const parsed = parseRouteDecision(
      'Here you go:\n```json\n{"action":"continue","sessionId":"s-2","prompt":"go","reason":"r","confidence":0.4}\n```',
      context,
    )
    expect(parsed.decision?.sessionId).toBe('s-2')
    expect(parsed.decision?.confidence).toBe(0.4)
  })

  it('clamps a confidence outside 0..1 and defaults a missing one', () => {
    expect(parseRouteDecision('{"action":"ignore","confidence":7}', context).decision?.confidence).toBe(1)
    expect(parseRouteDecision('{"action":"ignore","confidence":-3}', context).decision?.confidence).toBe(0)
    expect(parseRouteDecision('{"action":"ignore"}', context).decision?.confidence).toBe(0.5)
  })

  it('recovers a decision from an answer cut mid-object', () => {
    const parsed = parseRouteDecision(
      '{"action":"new_session","workspaceId":"ws-1","prompt":"create the plugin","reason":"new work","conf',
      context,
    )
    expect(parsed.decision?.action).toBe('new_session')
    expect(parsed.decision?.workspaceId).toBe('ws-1')
    expect(parsed.decision?.prompt).toBe('create the plugin')
  })

  it('salvages the action from structurally broken JSON', () => {
    const parsed = parseRouteDecision('{"action": "ignore", "reason": }', context)
    expect(parsed.decision?.action).toBe('ignore')
  })

  it('names an empty answer as such', () => {
    expect(parseRouteDecision('   ', context).error).toContain('nothing')
  })

  it('refuses an unknown action and a non-JSON answer', () => {
    expect(parseRouteDecision('{"action":"explode"}', context).error).toContain('unknown action')
    expect(parseRouteDecision('I think you should fix the build.', context).error).toContain('no JSON object')
    expect(parseRouteDecision('', context).error).toContain('nothing')
  })
})

describe('extractJsonObject', () => {
  it('prefers the fenced body, then the widest brace span', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJsonObject('prefix {"b":2} suffix')).toEqual({ b: 2 })
  })

  it('returns null for arrays and scalars', () => {
    expect(extractJsonObject('[1,2]')).toBeNull()
    expect(extractJsonObject('42')).toBeNull()
  })
})

describe('normalizeSummary', () => {
  const identity = { workspace: 'ws', workspacePath: '/p', session: 'Task', sessionId: 's-1' }

  it('replaces a model identity line with the deterministic one', () => {
    const text = normalizeSummary('Workspace: other | Session: thing\nAll good.', identity)
    expect(text).toBe('Workspace: ws | Session: Task\nAll good.')
  })

  it('prepends the identity when the model omitted it', () => {
    expect(normalizeSummary('All good.', identity)).toBe('Workspace: ws | Session: Task\nAll good.')
  })

  it('emits only the identity line for an empty body', () => {
    expect(normalizeSummary('   ', identity)).toBe('Workspace: ws | Session: Task')
  })
})

describe('composeNewSessionPrompt', () => {
  it('puts the carried facts before the human message', () => {
    const text = composeNewSessionPrompt('fix it', 'the cache key is in build.ts', {
      workspace: 'ws',
      workspacePath: '/p',
      session: 'Old task',
      sessionId: 's-1',
    })
    expect(text).toContain('Context carried over from session Old task (s-1)')
    expect(text).toContain('the cache key is in build.ts')
    expect(text.endsWith('fix it')).toBe(true)
  })

  it('passes plain text through when nothing is carried', () => {
    expect(composeNewSessionPrompt('fix it', '   ')).toBe('fix it')
  })
})

describe('withLanguageDirective', () => {
  it('appends the requested rule', () => {
    expect(withLanguageDirective('p', 'en')).toContain('Always answer in English.')
    expect(withLanguageDirective('p', 'zh')).toContain('简体中文')
    expect(withLanguageDirective('p', 'auto')).toContain('same language')
  })
})