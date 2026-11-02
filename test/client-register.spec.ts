/**
 * The built bundle's registration path, driven through a fake client context.
 *
 * The page cannot be seen from a test, but the two things that decide whether it
 * ever appears can: `apply` must run without throwing, and it must register into
 * `settings.section` with the label, locale namespace and injected form the seat
 * expects. A wrong slot id or a throwing `inject` factory retires the entry
 * silently in the real page, and nothing else notices.
 *
 * It skips with a visible note when the artifact has not been built yet;
 * `pnpm check` builds before it tests.
 *
 * @module dsh-feishu-session-manager/test/client-register
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NS, SECTION_ID, SETTINGS_NS } from '../src/client/plugin.ts'
import { en } from '../src/client/locales.ts'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const built = existsSync(bundlePath)

/** One captured slot registration. */
interface Registration {
  options: Record<string, unknown>
  component: unknown
}

/**
 * Execute the built bundle and return the module it registered.
 * @returns the module exports.
 */
function loadModule(): Record<string, unknown> {
  const source = readFileSync(bundlePath, 'utf8')
  const entries: { id: string; factory: (request: (specifier: string) => unknown) => Record<string, unknown> }[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (request: (specifier: string) => unknown) => Record<string, unknown> }) {
        entries.push(entry)
      },
    },
  }
  const require = createRequire(bundlePath)
  const seed: Record<string, unknown> = {
    react: require('react'),
    'react/jsx-runtime': require('react/jsx-runtime'),
  }
  const request = (specifier: string): unknown => {
    const found = seed[specifier]
    if (found === undefined) throw new Error(`unexpected module request: ${specifier}`)
    return found
  }
  const run = new Function('window', source) as (window: unknown) => void
  run(fakeWindow)
  const entry = entries[0]
  if (entry === undefined) throw new Error('the bundle registered no loader entry')
  return entry.factory(request)
}

/** A fake client context that records what the plugin registers. */
function fakeClient(registrations: Registration[]): {
  ctx: Record<string, unknown>
  servedNamespaces: () => string[]
} {
  const served: string[] = []
  const form = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { enabled: false },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
  const ctx: Record<string, unknown> = {
    effect: (callback: () => (() => void) | void) => {
      callback()
    },
    locale: {
      register: () => () => {},
      bind: () => (key: keyof typeof en) => en[key],
    },
    configForms: {
      get: () => form,
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        for (const namespace of namespaces) served.push(namespace)
        return register(new Set(namespaces))
      },
      subscribe: () => () => {},
    },
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    logger: { error() {} },
  }
  return { ctx, servedNamespaces: () => served }
}

describe.skipIf(!built)('the built client bundle', () => {
  it('registers one Settings section under its own id and namespace', () => {
    const module = loadModule()
    const registrations: Registration[] = []
    const { ctx, servedNamespaces } = fakeClient(registrations)
    const apply = module.apply as (context: unknown) => void
    apply(ctx)
    expect(servedNamespaces()).toEqual([SETTINGS_NS])
    expect(registrations).toHaveLength(1)
    const registration = registrations[0]
    expect(registration?.options.name).toBe('settings.section')
    expect(registration?.options.id).toBe(SECTION_ID)
    expect(registration?.options.locale).toBe(NS)
    expect(typeof registration?.options.order).toBe('number')
    const label = registration?.options.label as () => string
    expect(label()).toBe('Feishu')
    expect(typeof registration?.component).toBe('function')
  })

  it('injects the settings form, and the factory cannot throw', () => {
    const module = loadModule()
    const registrations: Registration[] = []
    const { ctx } = fakeClient(registrations)
    ;(module.apply as (context: unknown) => void)(ctx)
    const inject = registrations[0]?.options.inject as () => Record<string, unknown>
    expect(typeof inject).toBe('function')
    expect(() => inject()).not.toThrow()
    expect(typeof inject().form).toBe('object')
  })

  it('survives a context whose services are missing', () => {
    const module = loadModule()
    const broken = {
      effect: () => {},
      locale: {
        register: () => () => {},
        bind: () => () => '',
      },
      configForms: {
        get: () => {
          throw new Error('no namespace')
        },
        whileServed: () => () => {},
      },
      slots: { inject: () => () => {}, register: () => () => {} },
      logger: { error() {} },
    }
    expect(() => {
      ;(module.apply as (context: unknown) => void)(broken)
    }).not.toThrow()
  })
})

describe.skipIf(built)('the built client bundle', () => {
  it('is missing', () => {
    console.warn('[test] lib/client.js has not been built yet; run pnpm build')
    expect(built).toBe(true)
  })
})