/**
 * The wire contract shared by both halves.
 *
 * The paths are the one thing that can silently break in production: a page
 * mounted under a prefix must request a document-relative path, while the host
 * registers an origin-absolute one.
 *
 * @module dsh-feishu-session-manager/test/protocol
 */

import { describe, expect, it } from 'vitest'
import { API, CLIENT_API, PLUGIN_ID, clientPath } from '../src/protocol.ts'

describe('API', () => {
  it('serves every route under the plugin id', () => {
    for (const path of Object.values(API)) {
      expect(path.startsWith(`/api/${PLUGIN_ID}/`)).toBe(true)
    }
  })

  it('has one distinct path per route', () => {
    const paths = Object.values(API)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('clientPath', () => {
  it('drops exactly one leading slash', () => {
    expect(clientPath('/api/x/y')).toBe('api/x/y')
    expect(clientPath('api/x/y')).toBe('api/x/y')
    expect(clientPath('/a')).toBe('a')
  })
})

describe('CLIENT_API', () => {
  it('is derived from API, so the halves cannot drift', () => {
    for (const [key, value] of Object.entries(CLIENT_API)) {
      const hostPath = API[key as keyof typeof API]
      expect(value).toBe(hostPath.replace(/^\//, ''))
      expect(value.startsWith('/')).toBe(false)
    }
  })

  it('covers every host route', () => {
    expect(Object.keys(CLIENT_API).sort()).toEqual(Object.keys(API).sort())
  })
})