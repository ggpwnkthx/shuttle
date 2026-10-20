import { describe, expect, test } from 'bun:test'
import { ConfigurationStore, isReservedPath, parseConfig } from './index'

/** A configuration that is valid, as the base of the tests. */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    defaults: { auth: { mode: 'none' }, timeouts: { responseMs: 5000 } },
    routes: [
      {
        id: 'public-site',
        match: { host: 'app.example.com', path: '/' },
        upstream: 'http://upstream-a:3000',
      },
    ],
    ...overrides,
  }
}

/** A store with the defaults of the tests. */
function store(): ConfigurationStore {
  return new ConfigurationStore({
    source: '/etc/shuttle/routes.json',
    defaultMaxBodyBytes: 1_048_576,
    trustedProxies: ['10.0.0.0/8'],
  })
}

describe('the schema of the configuration', () => {
  test('a valid configuration is accepted', () => {
    const config = parseConfig(baseConfig())
    expect(config.version).toBe(1)
    expect(config.routes).toHaveLength(1)
  })

  test('an unknown key is a configuration error', () => {
    expect(() => parseConfig(baseConfig({ surprise: true }))).toThrow()
  })

  test('the old names of the budgets are refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          defaults: { auth: { mode: 'none' }, timeouts: { connectMs: 1000 } },
        })
      )
    ).toThrow()
  })

  test('an upstream with a query string is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/' },
              upstream: 'http://upstream:3000/?token=1',
            },
          ],
        })
      )
    ).toThrow()
  })

  test('an upstream with a fragment is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/' },
              upstream: 'http://upstream:3000/#fragment',
            },
          ],
        })
      )
    ).toThrow()
  })

  test('an upstream that is not served over http is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/' },
              upstream: 'ftp://upstream:3000',
            },
          ],
        })
      )
    ).toThrow()
  })

  test('a workspace check without a credential is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/ws/{workspaceId}/' },
              upstream: 'http://upstream:3000',
              auth: { mode: 'none', workspace: { param: 'workspaceId' } },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('a workspace check that names a placeholder the path does not have is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/ws/{workspaceId}/' },
              upstream: 'http://upstream:3000',
              auth: { mode: 'any', workspace: { param: 'otherId' } },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('the path template of a route is validated', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [{ id: 'a', match: { host: '*', path: 'ws' }, upstream: 'http://upstream:3000' }],
        })
      )
    ).toThrow()
  })
})

describe('the effective policy of a route', () => {
  test('the policy of a route replaces the default policy', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        defaults: { auth: { mode: 'session' } },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            auth: { mode: 'jwt' },
          },
          {
            id: 'b',
            match: { host: 'b.example.com', path: '/' },
            upstream: 'http://upstream:3000',
          },
        ],
      })
    )
    expect(result.ok).toBe(true)
    const snapshot = configuration.snapshot!
    expect(snapshot.routes.find((route) => route.id === 'a')!.payload.auth.mode).toBe('jwt')
    expect(snapshot.routes.find((route) => route.id === 'b')!.payload.auth.mode).toBe('session')
  })

  test('the budgets are merged field by field', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        defaults: {
          auth: { mode: 'none' },
          timeouts: { responseMs: 5000, firstByteMs: 30_000, bodyMs: 300_000 },
        },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            timeouts: { responseMs: 2000 },
          },
        ],
      })
    )
    const route = configuration.snapshot!.routes[0]!.payload
    expect(route.timeouts.responseMs).toBe(2000)
    expect(route.timeouts.firstByteMs).toBe(30_000)
    expect(route.timeouts.bodyMs).toBe(300_000)
  })

  test('the limit of the body comes from the route, then the defaults, then the environment', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        defaults: { auth: { mode: 'none' }, maxBodyBytes: 2048 },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            maxBodyBytes: 1024,
          },
          {
            id: 'b',
            match: { host: 'b.example.com', path: '/' },
            upstream: 'http://upstream:3000',
          },
        ],
      })
    )
    const snapshot = configuration.snapshot!
    expect(snapshot.routes.find((route) => route.id === 'a')!.payload.maxBodyBytes).toBe(1024)
    expect(snapshot.routes.find((route) => route.id === 'b')!.payload.maxBodyBytes).toBe(2048)

    const withoutDefaults = store()
    withoutDefaults.apply(
      baseConfig({
        routes: [{ id: 'a', match: { host: '*', path: '/' }, upstream: 'http://upstream:3000' }],
      })
    )
    expect(withoutDefaults.snapshot!.routes[0]!.payload.maxBodyBytes).toBe(1_048_576)
  })
})

describe('the publication of a configuration', () => {
  test('a valid configuration is published', () => {
    const configuration = store()
    const result = configuration.apply(baseConfig())
    expect(result.ok).toBe(true)
    expect(configuration.snapshot?.revision).toBe(1)
    expect(configuration.lastError).toBeNull()
  })

  test('an invalid configuration keeps the last good one', () => {
    const configuration = store()
    configuration.apply(baseConfig())
    const result = configuration.apply(baseConfig({ version: 2 }))
    expect(result.ok).toBe(false)
    expect(configuration.snapshot?.revision).toBe(1)
    expect(configuration.lastError?.message).toContain('invalid configuration')
  })

  test('two routes with the same id are refused', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        routes: [
          { id: 'a', match: { host: '*', path: '/one' }, upstream: 'http://upstream:3000' },
          { id: 'a', match: { host: '*', path: '/two' }, upstream: 'http://upstream:3000' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(configuration.lastError?.details.join(' ')).toContain('duplicate route id')
  })

  test('two ambiguous routes are refused', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'a',
            match: { host: 'api.example.com', path: '/ws/{id}/' },
            upstream: 'http://upstream:3000',
          },
          {
            id: 'b',
            match: { host: 'api.example.com', path: '/ws/{other}/' },
            upstream: 'http://upstream:3000',
          },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(configuration.lastError?.details.join(' ')).toContain('ambiguous')
  })

  test('a route that claims a path of the gateway is refused', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        routes: [
          { id: 'a', match: { host: '*', path: '/metrics' }, upstream: 'http://upstream:3000' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(configuration.lastError?.details.join(' ')).toContain('reserved path')
  })

  test('a route that claims a path of the configuration is refused', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        reservedPaths: ['/internal'],
        routes: [
          { id: 'a', match: { host: '*', path: '/internal/' }, upstream: 'http://upstream:3000' },
        ],
      })
    )
    expect(result.ok).toBe(false)
  })

  test('the ranges of the environment are added to the ranges of the file', () => {
    const configuration = store()
    configuration.apply(baseConfig({ trustedProxies: ['192.168.0.0/16'] }))
    expect(configuration.snapshot?.trustedProxies).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
  })

  test('the paths of the gateway are reserved', () => {
    const configuration = store()
    configuration.apply(baseConfig())
    const snapshot = configuration.snapshot!
    expect(isReservedPath(snapshot, '/healthz')).toBe(true)
    expect(isReservedPath(snapshot, '/metrics/')).toBe(true)
    expect(isReservedPath(snapshot, '/')).toBe(false)
  })
})
