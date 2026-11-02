/**
 * The advertised version is the built artifact's version.
 *
 * A page header that prints a version nobody built is worse than no header: the
 * reader uses that line to decide whether a reinstall took effect. The host's
 * status route and the page read the same constant, so this test guards both.
 *
 * @module dsh-feishu-session-manager/test/version
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AUTHORS, VERSION } from '../src/version.ts'

describe('VERSION', () => {
  it('equals the version in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown }
    expect(manifest.version).toBe(VERSION)
  })

  it('is a plain semantic version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('carries the style-contract credit verbatim', () => {
    // The workspace style contract requires this exact name and address, never
    // translated or reworded, beside the version.
    expect(AUTHORS).toBe('icrefin [icrefinai@gmail.com]')
  })
})
