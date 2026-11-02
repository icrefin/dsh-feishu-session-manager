/**
 * The built client bundle, loaded the way the browser module system loads it.
 *
 * The source specs exercise the source. This one executes `lib/client.js` behind
 * a fake `window.__ModuleLoader__`, which is the only check that catches a broken
 * loader banner — a wrong `id` fails the live page with
 * `loaded without registering "<id>"`, and nothing else notices.
 *
 * It skips with a visible note when the artifact has not been built yet;
 * `pnpm check` builds before it tests, so a normal run always exercises it.
 *
 * @module dsh-feishu-session-manager/test/bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NS, SECTION_ID, inject } from '../src/client/plugin.ts'

const packageName = 'dsh-feishu-session-manager'
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const built = existsSync(bundlePath)

/** One loader entry, captured from the fake module table. */
interface LoaderEntry {
  id: string
  factory: (request: (specifier: string) => unknown) => Record<string, unknown>
}

/**
 * Materialize the built bundle behind a fake loader.
 * @returns the module the bundle registered.
 */
function loadBundle(): { entries: LoaderEntry[]; module: Record<string, unknown> } {
  const source = readFileSync(bundlePath, 'utf8')
  const entries: LoaderEntry[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry: LoaderEntry) {
        entries.push(entry)
      },
    },
  }
  const require = createRequire(bundlePath)
  const platform = {
    react: require('react'),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-dom': require('react-dom'),
  }
  const request = (specifier: string): unknown => {
    const found = platform[specifier as keyof typeof platform]
    if (found === undefined) throw new Error(`the bundle requested an unexpected module: ${specifier}`)
    return found
  }
  // The bundle is an expression that registers itself against `window`.
  const run = new Function('window', source) as (window: unknown) => void
  run(fakeWindow)
  const entry = entries[0]
  if (entry === undefined) throw new Error('the bundle registered no loader entry')
  return { entries, module: entry.factory(request) }
}

describe.skipIf(!built)('the built client bundle', () => {
  it('registers exactly one entry under the package name', () => {
    const { entries } = loadBundle()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe(packageName)
  })

  it('exports the plugin contract the loader calls', () => {
    const { module } = loadBundle()
    expect(typeof module.apply).toBe('function')
    expect(module.inject).toEqual(inject)
    expect(module.NS).toBe(NS)
    expect(module.SECTION_ID).toBe(SECTION_ID)
  })

  it('declares the settings services it registers against', () => {
    const { module } = loadBundle()
    const declared = module.inject as string[]
    expect(declared).toContain('slots')
    expect(declared).toContain('locale')
    expect(declared).toContain('configForms')
  })
})

describe.skipIf(built)('the built client bundle', () => {
  it('is missing', () => {
    console.warn('[test] lib/client.js has not been built yet; run pnpm build')
    expect(built).toBe(true)
  })
})