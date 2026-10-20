import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  checkArchitecture,
  findForbiddenDirectories,
  loadSources,
  unlocatedFiles,
  type SourceFile,
} from '../../scripts/architecture'

const root = resolve(import.meta.dir, '..', '..')

/** Builds the source of a file of the project. */
function source(path: string, content: string): SourceFile {
  return { path, content }
}

describe('the import boundaries of the project', () => {
  test('the source tree respects them', async () => {
    const sources = await loadSources(root)
    const violations = checkArchitecture(sources)
    expect(violations).toEqual([])
  })

  test('every file of the tree belongs to a known layer', async () => {
    const sources = await loadSources(root)
    expect(unlocatedFiles(sources)).toEqual([])
  })

  test('there is no directory that collects unrelated behaviour', async () => {
    expect(await findForbiddenDirectories(root)).toEqual([])
  })
})

describe('the rules of the import boundaries', () => {
  test('a domain is imported through its public entry point', () => {
    const violations = checkArchitecture([
      source('src/domains/proxying/exchange.ts', "import { plan } from '../forwarding/plan'\n"),
      source('src/domains/forwarding/plan.ts', 'export const plan = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('domain-import-not-public')
  })

  test('the public entry point of a domain is enough', () => {
    const violations = checkArchitecture([
      source('src/domains/proxying/exchange.ts', "import { plan } from '../forwarding'\n"),
      source('src/domains/forwarding/index.ts', 'export const plan = 1\n'),
    ])
    expect(violations).toEqual([])
  })

  test('a domain may only use the domains it is allowed to use', () => {
    const violations = checkArchitecture([
      source(
        'src/domains/routing/match.ts',
        "import { policy } from '../authentication'\nimport { policy as other } from '../forwarding'\n"
      ),
      source('src/domains/authentication/index.ts', 'export const policy = 1\n'),
      source('src/domains/forwarding/index.ts', 'export const policy = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-dependency-not-allowed',
      'domain-dependency-not-allowed',
    ])
  })

  test('a core domain file imports no framework and no boundary layer', () => {
    const violations = checkArchitecture([
      source('src/domains/proxying/exchange.ts', "import { Hono } from 'hono'\n"),
      source('src/domains/proxying/adapter.ts', "import { app } from '../../app/app'\n"),
      source('src/app/app.ts', 'export const app = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-core-imports-framework',
      'domain-core-imports-boundary',
    ])
  })

  test('an adapter of a domain may use a library', () => {
    const violations = checkArchitecture([
      source('src/domains/proxying/adapters/bun.ts', "import { serve } from 'hono'\n"),
    ])
    expect(violations).toEqual([])
  })

  test('the application uses no concrete adapter', () => {
    const violations = checkArchitecture([
      source(
        'src/app/app.ts',
        "import { store } from '../domains/authentication/adapters/memory'\n"
      ),
      source('src/domains/authentication/adapters/memory.ts', 'export const store = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-import-not-public',
      'app-imports-adapter',
    ])
  })

  test('the platform knows neither the application nor the runtime', () => {
    const violations = checkArchitecture([
      source('src/platform/bun/listener.ts', "import { app } from '../../app/app'\n"),
      source('src/platform/bun/other.ts', "import { runtime } from '../../runtime/composition'\n"),
      source('src/app/app.ts', 'export const app = 1\n'),
      source('src/runtime/composition.ts', 'export const runtime = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'platform-imports-boundary',
      'platform-imports-boundary',
    ])
  })

  test('the observation layer is independent', () => {
    const violations = checkArchitecture([
      source('src/observability/metrics.ts', "import { matchRoute } from '../domains/routing'\n"),
      source('src/domains/routing/index.ts', 'export const matchRoute = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'observability-imports-boundary',
    ])
  })

  test('the composition root may use the adapters of a domain', () => {
    const violations = checkArchitecture([
      source(
        'src/runtime/composition.ts',
        "import { store } from '../domains/authentication/adapters'\n"
      ),
      source('src/domains/authentication/adapters/index.ts', 'export const store = 1\n'),
    ])
    expect(violations).toEqual([])
  })

  test('an import cycle is refused', () => {
    const violations = checkArchitecture([
      source('src/domains/routing/a.ts', "import { b } from './b'\n"),
      source('src/domains/routing/b.ts', "import { a } from './a'\n"),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('import-cycle')
  })

  test('a type only import is a dependency as well', () => {
    const violations = checkArchitecture([
      source(
        'src/domains/proxying/exchange.ts',
        "import type { Plan } from '../forwarding/plan'\n"
      ),
      source('src/domains/forwarding/plan.ts', 'export type Plan = unknown\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['domain-import-not-public'])
  })

  test('the public entry point of a domain holds no adapter', () => {
    const violations = checkArchitecture([
      source('src/domains/authentication/index.ts', "import { store } from './adapters/memory'\n"),
      source('src/domains/authentication/adapters/memory.ts', 'export const store = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('domain-entry-uses-adapter')
  })
})

describe('the location of a file', () => {
  test('a domain file is located in its domain', () => {
    const violations = checkArchitecture([
      source('src/domains/rate-limiting/limiter.ts', "import { policy } from '../configuration'\n"),
      source('src/domains/configuration/index.ts', 'export const policy = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['domain-dependency-not-allowed'])
  })
})

test('the forbidden directories are found', async () => {
  expect(await findForbiddenDirectories(root)).toEqual([])
})
