/**
 * Feishu message shapes, driven by the shapes Feishu actually delivers.
 *
 * These are the failures that reach users: a mention left in the routed prompt, a
 * long summary cut mid-word, a push that never says which session it came from.
 *
 * @module dsh-feishu-session-manager/test/format
 */

import { describe, expect, it } from 'vitest'
import {
  chunkText,
  extractText,
  formatApproval,
  formatCompletion,
  formatQuestion,
  formatRouted,
  formatSessionList,
  identityLine,
  parseCommand,
  shortId,
  stripMentions,
} from '../src/feishu/format.ts'

describe('extractText', () => {
  it('reads a plain text message', () => {
    expect(extractText('text', JSON.stringify({ text: 'hello there' }))).toBe('hello there')
  })

  it('reads a rich-text post, keeping paragraphs and links', () => {
    const content = JSON.stringify({
      title: 'Build report',
      content: [
        [{ tag: 'text', text: 'The build ' }, { tag: 'a', text: 'passed', href: 'http://x' }],
        [{ tag: 'text', text: 'next: ship it' }],
      ],
    })
    expect(extractText('post', content)).toBe('Build report\nThe build passed\nnext: ship it')
  })

  it('reports an image message as empty rather than throwing', () => {
    expect(extractText('image', JSON.stringify({ image_key: 'img_v2_abc' }))).toBe('')
  })

  it('tolerates broken JSON and missing content', () => {
    expect(extractText('text', '{not json')).toBe('')
    expect(extractText('text', undefined)).toBe('')
  })
})

describe('stripMentions', () => {
  it('removes the placeholder keys Feishu puts in the text', () => {
    expect(stripMentions('@_user_1 please check', [{ key: '@_user_1', name: 'bot' }])).toBe('please check')
  })

  it('collapses the spaces a removed mention leaves behind', () => {
    expect(stripMentions('@_user_1  build the  docs', [{ key: '@_user_1' }])).toBe('build the docs')
  })

  it('leaves text without mentions untouched, trimmed', () => {
    expect(stripMentions('  plain text  ', undefined)).toBe('plain text')
  })
})

describe('chunkText', () => {
  it('returns one chunk for short text', () => {
    expect(chunkText('short', 400)).toEqual(['short'])
  })

  it('splits on a paragraph boundary when one is available', () => {
    const first = 'a'.repeat(240)
    const second = 'b'.repeat(240)
    const chunks = chunkText(`${first}\n\n${second}`, 260)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe(first)
    expect(chunks[1]).toBe(second)
  })

  it('never loses or reorders characters', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${String(index)} of the report`).join('\n')
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(text)
  })

  it('raises a too-small budget to the minimum and keeps everything', () => {
    const text = 'x'.repeat(500)
    const chunks = chunkText(text, 10)
    expect(chunks.join('')).toBe(text)
  })

  it('drops empty input', () => {
    expect(chunkText('   \n ', 100)).toEqual([])
  })
})

describe('identityLine', () => {
  it('always names the workspace and the session, with a short id', () => {
    const line = identityLine({
      workspace: 'dsh-plugins',
      workspacePath: '/work/dsh-plugins',
      session: 'Fix the build',
      sessionId: '9f2c1a4b-1111-2222',
    })
    expect(line).toContain('dsh-plugins')
    expect(line).toContain('Fix the build')
    expect(line).toContain('[9f2c1a4b]')
  })

  it('truncates a very long path from the left, keeping the segment that names it', () => {
    const line = identityLine({
      workspace: 'w',
      workspacePath: `/very/${'deep/'.repeat(12)}leaf`,
      session: 's',
      sessionId: 'abcdef',
    })
    expect(line).toContain('…')
    expect(line).toContain('leaf | Session: s')
  })
})

describe('formatCompletion', () => {
  const identity = { workspace: 'ws', workspacePath: '/p/ws', session: 'Task', sessionId: 'abc12345' }

  it('prints its own identity line and drops the model duplicate', () => {
    const text = formatCompletion({
      identity,
      body: 'Workspace: ws | Session: Task\nWhat happened: the build passed.',
      outcome: 'completed',
    })
    expect(text.startsWith('✅ Turn finished')).toBe(true)
    expect(text).toContain('Workspace: ws')
    expect(text.match(/Workspace: ws/g)).toHaveLength(1)
    expect(text).toContain('the build passed')
  })

  it('marks a failure and carries its code', () => {
    const text = formatCompletion({ identity, body: 'it broke', outcome: 'failed', failureCode: 'RATE_LIMIT' })
    expect(text).toContain('⚠️ Turn failed (RATE_LIMIT)')
  })
})

describe('formatQuestion', () => {
  it('numbers the options and states the reply grammar and timeout', () => {
    const text = formatQuestion({
      identity: { workspace: 'ws', session: 'Task', sessionId: 'abc12345' },
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'needs a server' }],
      multiSelect: false,
      timeoutMinutes: 15,
    })
    expect(text).toContain('1) SQLite')
    expect(text).toContain('2) Postgres — needs a server')
    expect(text).toContain('Reply with an option number')
    expect(text).toContain('15 min')
  })

  it('explains the free-text path when there are no options', () => {
    const text = formatQuestion({
      identity: { workspace: 'ws', session: 'Task', sessionId: 'abc12345' },
      question: 'Name it',
      options: [],
      multiSelect: false,
      timeoutMinutes: 5,
    })
    expect(text).toContain('Reply with your answer as text.')
  })
})

describe('formatApproval', () => {
  it('offers the two outcomes and the tool', () => {
    const text = formatApproval({
      identity: { workspace: 'ws', session: 'Task', sessionId: 'abc12345' },
      toolName: 'bash',
      reason: 'writes outside the workspace',
      timeoutMinutes: 15,
    })
    expect(text).toContain('🔐 Permission request')
    expect(text).toContain('Tool: bash')
    expect(text).toContain('writes outside the workspace')
    expect(text).toContain('Reply 1 to allow')
    expect(text).toContain('2 to reject')
  })
})

describe('formatRouted', () => {
  it('carries the fallback note when the route was not the model\'s', () => {
    const text = formatRouted(
      { workspace: 'ws', session: 'Task', sessionId: 'abc12345' },
      'routing model answer unusable; new session in ws',
      '⚠️ Routed by fallback.',
    )
    expect(text.startsWith('📨 Routed')).toBe(true)
    expect(text).toContain('Why: routing model answer unusable')
    expect(text).toContain('⚠️ Routed by fallback.')
  })

  it('omits the note on a normal route', () => {
    const text = formatRouted({ workspace: 'ws', session: 'Task', sessionId: 'abc12345' }, 'same topic')
    expect(text).not.toContain('fallback')
  })
})

describe('formatSessionList', () => {
  it('numbers the rows and explains how to use them', () => {
    const text = formatSessionList(
      [
        {
          index: 1,
          identity: { workspace: 'ws', session: 'Task one', sessionId: 'aaaa1111' },
          running: true,
          waiting: false,
          updatedAt: 0,
        },
        {
          index: 2,
          identity: { workspace: 'ws', session: 'Task two', sessionId: 'bbbb2222' },
          running: false,
          waiting: true,
          updatedAt: 0,
        },
      ],
      'Use /use <n>.',
    )
    expect(text).toContain('1. Task one [aaaa1111]')
    expect(text).toContain('running')
    expect(text).toContain('2. Task two [bbbb2222]')
    expect(text).toContain('WAITING')
    expect(text.endsWith('Use /use <n>.')).toBe(true)
  })

  it('explains an empty installation instead of showing nothing', () => {
    expect(formatSessionList([], 'help me')).toContain('No sessions visible yet.')
  })
})

describe('parseCommand', () => {
  it('recognizes each command, case-insensitively', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('/STATUS')).toEqual({ kind: 'status' })
    expect(parseCommand('/sessions')).toEqual({ kind: 'sessions' })
    expect(parseCommand('/bind')).toEqual({ kind: 'bind' })
    expect(parseCommand('/use 3')).toEqual({ kind: 'use', target: '3' })
    expect(parseCommand('/new dsh-plugins')).toEqual({ kind: 'new', workspaceHint: 'dsh-plugins' })
    expect(parseCommand('/skip fix the build')).toEqual({ kind: 'skip', text: 'fix the build' })
  })

  it('treats free text and an unknown command as no command', () => {
    expect(parseCommand('please fix the build')).toEqual({ kind: 'none' })
    expect(parseCommand('/nope')).toEqual({ kind: 'none' })
    expect(parseCommand('/use')).toEqual({ kind: 'none' })
  })
})

describe('shortId', () => {
  it('keeps eight characters and never invents one', () => {
    expect(shortId('0123456789')).toBe('01234567')
    expect(shortId('abc')).toBe('abc')
  })
})