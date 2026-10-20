import { describe, expect, test } from 'bun:test'
import {
  ConfigValidationError,
  isUuid,
  parseConfig,
  type ShuttleConfig,
} from '../src/config/schema'
import { compileRoutes, detectConflicts, matchRoute, sortRoutes } from '../src/config/matcher'
import { resolveTimeouts } from '../src/gateway/upstream'
import { ConfigStore } from '../src/config/store'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function config(routes: unknown[]): ShuttleConfig {
  return parseConfig({ version: 1, routes })
}

describe('configuration schema', () => {
  test('rejects an unknown version', () => {
    expect(() => parseConfig({ version: 2, routes: [] })).toThrow(ConfigValidationError)
  })

  test('rejects a route without an upstream', () => {
    expect(() =>
      config([{ id: 'broken', match: { host: 'a.test', path: '/' } }])
    ).toThrow(ConfigValidationError)
  })

  test('rejects duplicate route identifiers', () => {
    const parsed = config([
      { id: 'same', match: { host: 'a.test', path: '/' }, upstream: 'http://a' },
      { id: 'same', match: { host: 'b.test', path: '/' }, upstream: 'http://b' },
    ])
    const conflicts = detectConflicts(sortRoutes(compileRoutes(parsed)))
    expect(conflicts.join(' ')).toContain('duplicate route id')
  })

  test('rejects an ambiguous route pair', () => {
    const parsed = config([
      {
        id: 'first',
        match: { host: 'api.test', path: '/ws/{workspaceId}/' },
        upstream: 'http://a',
      },
      {
        id: 'second',
        match: { host: 'api.test', path: '/ws/{other}/' },
        upstream: 'http://b',
      },
    ])
    const conflicts = detectConflicts(sortRoutes(compileRoutes(parsed)))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain('ambiguous')
  })

  test('accepts routes that differ in their literal suffix', () => {
    const parsed = config([
      {
        id: 'first',
        match: { host: 'api.test', path: '/ws/{workspaceId}/' },
        upstream: 'http://a',
      },
      {
        id: 'second',
        match: { host: 'api.test', path: '/ws/{workspaceId}/assets/' },
        upstream: 'http://b',
      },
    ])
    expect(detectConflicts(sortRoutes(compileRoutes(parsed)))).toHaveLength(0)
  })

  test('rejects a workspace check without authentication', () => {
    expect(() =>
      config([
        {
          id: 'workspace',
          match: { host: 'api.test', path: '/ws/{workspaceId}/' },
          upstream: 'http://a',
          auth: { mode: 'none', workspace: { param: 'workspaceId' } },
        },
      ])
    ).toThrow(ConfigValidationError)
  })

  test('rejects a role check, the gateway does not decide roles', () => {
    expect(() =>
      config([
        {
          id: 'admin',
          match: { host: 'api.test', path: '/' },
          upstream: 'http://a',
          auth: { mode: 'none', roles: ['admin'] },
        },
      ])
    ).toThrow(ConfigValidationError)
  })
})

describe('the default policy of the routes', () => {
  test('a route without a policy uses the default policy', () => {
    const parsed = parseConfig({
      version: 1,
      defaults: { auth: { mode: 'session' } },
      routes: [{ id: 'a', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }],
    })
    expect(parsed.routes[0]!.auth.mode).toBe('session')
  })

  test('the policy of a route replaces the default policy', () => {
    const parsed = parseConfig({
      version: 1,
      defaults: { auth: { mode: 'session' } },
      routes: [
        {
          id: 'a',
          match: { host: 'a.test', path: '/' },
          upstream: 'http://a',
          auth: { mode: 'none' },
        },
      ],
    })
    expect(parsed.routes[0]!.auth.mode).toBe('none')
  })

  test('a route inherits the workspace check of the default policy', () => {
    const parsed = parseConfig({
      version: 1,
      defaults: {
        auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
      },
      routes: [
        { id: 'a', match: { host: 'a.test', path: '/ws/{workspaceId}/' }, upstream: 'http://a' },
      ],
    })
    expect(parsed.routes[0]!.auth.workspace?.param).toBe('workspaceId')
  })

  test('a default policy without an authentication mode is rejected', () => {
    expect(() =>
      parseConfig({
        version: 1,
        defaults: { auth: { mode: 'none', workspace: { param: 'workspaceId' } } },
        routes: [
          { id: 'a', match: { host: 'a.test', path: '/ws/{workspaceId}/' }, upstream: 'http://a' },
        ],
      })
    ).toThrow(/workspace check needs an authentication mode/)
  })

  test('the default policy is "none" when nothing is configured', () => {
    const parsed = config([{ id: 'a', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }])
    expect(parsed.routes[0]!.auth.mode).toBe('none')
  })
})

describe('the budgets of the routes', () => {
  test('a route keeps the budgets it does not set', () => {
    const parsed = parseConfig({
      version: 1,
      defaults: { timeouts: { connectMs: 1_000, headersMs: 2_000, bodyMs: 3_000 } },
      routes: [
        {
          id: 'a',
          match: { host: 'a.test', path: '/' },
          upstream: 'http://a',
          timeouts: { connectMs: 500 },
        },
      ],
    })
    expect(parsed.routes[0]!.timeouts).toEqual({ connectMs: 500 })
    expect(parsed.defaults.timeouts.headersMs).toBe(2_000)
  })

  test('the budgets of a route are merged with the budgets of the configuration', () => {
    const configured = { connectMs: 1_000, headersMs: 2_000, bodyMs: 3_000 }
    expect(resolveTimeouts(configured, { connectMs: 500 })).toEqual({
      connectMs: 500,
      headersMs: 2_000,
      bodyMs: 3_000,
    })
    expect(resolveTimeouts(configured, undefined)).toEqual(configured)
  })
})

describe('route precedence', () => {
  const parsed = config([
    {
      id: 'wildcard',
      match: { host: '*.test', path: '/' },
      upstream: 'http://wildcard',
    },
    {
      id: 'exact-host',
      match: { host: 'api.test', path: '/' },
      upstream: 'http://exact',
    },
    {
      id: 'literal-path',
      match: { host: 'api.test', path: '/public/' },
      upstream: 'http://literal',
    },
  ])
  const routes = sortRoutes(compileRoutes(parsed))

  test('an exact host beats a wildcard host', () => {
    const match = matchRoute(routes, 'api.test', '/anything')
    expect(match?.route.id).toBe('exact-host')
  })

  test('a wildcard host is used for unknown hosts', () => {
    const match = matchRoute(routes, 'other.test', '/anything')
    expect(match?.route.id).toBe('wildcard')
  })

  test('a longer literal path prefix wins on the same host', () => {
    const match = matchRoute(routes, 'api.test', '/public/index.html')
    expect(match?.route.id).toBe('literal-path')
  })

  test('path parameters are captured', () => {
    const workspace = config([
      {
        id: 'workspace',
        match: { host: 'api.test', path: '/ws/{workspaceId}/' },
        upstream: 'http://a',
      },
    ])
    const match = matchRoute(sortRoutes(compileRoutes(workspace)), 'api.test', '/ws/abc-123/data')
    expect(match?.params).toEqual({ workspaceId: 'abc-123' })
  })

  test('the host is matched without the port', () => {
    const match = matchRoute(routes, 'api.test:8080', '/anything')
    expect(match?.route.id).toBe('exact-host')
  })
})

describe('the path templates', () => {
  test('a placeholder must be a whole segment', () => {
    expect(() =>
      config([{ id: 'a', match: { host: 'a.test', path: '/ws/x{workspaceId}' }, upstream: 'http://a' }])
    ).toThrow(/path template/)
  })

  test('a literal segment must not contain a placeholder character', () => {
    expect(() =>
      config([{ id: 'a', match: { host: 'a.test', path: '/ws/a:b/' }, upstream: 'http://a' }])
    ).toThrow(/path template/)
  })

  test('a wildcard is not a segment of a template', () => {
    expect(() =>
      config([{ id: 'a', match: { host: 'a.test', path: '/ws/*rest/' }, upstream: 'http://a' }])
    ).toThrow(/path template/)
  })

  test('a placeholder that is used twice is rejected', () => {
    const parsed = config([
      { id: 'a', match: { host: 'a.test', path: '/ws/{id}/{id}/' }, upstream: 'http://a' },
    ])
    expect(() => compileRoutes(parsed)).toThrow(/twice/)
  })

  test('a template matches the paths below it', () => {
    const parsed = config([
      { id: 'a', match: { host: 'a.test', path: '/ws/{workspaceId}/' }, upstream: 'http://a' },
    ])
    const routes = sortRoutes(compileRoutes(parsed))
    expect(matchRoute(routes, 'a.test', '/ws/abc')?.params.workspaceId).toBe('abc')
    expect(matchRoute(routes, 'a.test', '/ws/abc/assets')?.params.workspaceId).toBe('abc')
    expect(matchRoute(routes, 'a.test', '/ws')).toBeNull()
  })

  test('a path with a broken percent encoding does not match a route', () => {
    // The route matched, but the placeholder could not be decoded. A route
    // that matched with an unusable placeholder would forward a request
    // whose identifier is missing, which is a different request than the
    // one the route describes.
    const parsed = config([
      { id: 'a', match: { host: 'a.test', path: '/ws/{workspaceId}/' }, upstream: 'http://a' },
    ])
    const routes = sortRoutes(compileRoutes(parsed))
    expect(matchRoute(routes, 'a.test', '/ws/a%ZZ/')).toBeNull()
    // A valid encoding is decoded.
    expect(matchRoute(routes, 'a.test', '/ws/a%20b/')?.params.workspaceId).toBe('a b')
  })
})

describe('the workspace identifiers', () => {
  test('an identifier that is not a uuid is not one', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(false)
  })
})

describe('configuration store', () => {
  test('keeps the previous configuration when a reload is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-config-'))
    const path = join(directory, 'routes.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        routes: [{ id: 'ok', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }],
      })
    )
    const store = new ConfigStore(path)
    const first = await store.reload()
    expect(first.ok).toBe(true)
    expect(store.state.routes).toHaveLength(1)

    await writeFile(path, JSON.stringify({ version: 1, routes: [] }))
    const second = await store.reload()
    expect(second.ok).toBe(false)
    expect(store.loaded).toBe(true)
    expect(store.state.routes).toHaveLength(1)
    expect(store.lastError?.message).toContain('invalid configuration')

    await rm(directory, { recursive: true, force: true })
  })

  test('keeps the previous configuration when the file is not valid JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-config-'))
    const path = join(directory, 'routes.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        routes: [{ id: 'ok', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }],
      })
    )
    const store = new ConfigStore(path)
    await store.reload()
    await writeFile(path, '{ not json')
    const result = await store.reload()
    expect(result.ok).toBe(false)
    expect(store.state.routes).toHaveLength(1)
    expect(store.lastError?.message).toContain('not valid JSON')
    await rm(directory, { recursive: true, force: true })
  })

  test('a rejected configuration never becomes active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-config-'))
    const path = join(directory, 'routes.json')
    await writeFile(path, JSON.stringify({ version: 1, routes: [] }))
    const store = new ConfigStore(path)
    const result = await store.reload()
    expect(result.ok).toBe(false)
    expect(store.loaded).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })
})
