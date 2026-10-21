import { describe, expect, test } from 'bun:test'
import { ConfigurationStore, describeConfiguration, isReservedPath, parseConfig } from './index'

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

  test('the rewrite of a route is validated', () => {
    // A rewrite is a list of segments that starts with a slash.
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/ws/{workspaceId}/' },
              upstream: 'http://upstream:3000',
              rewrite: 'v1/{rest}',
            },
          ],
        })
      )
    ).toThrow()
    // The rest of the path may only be the last segment.
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/ws/{workspaceId}/' },
              upstream: 'http://upstream:3000',
              rewrite: '/{rest}/more',
            },
          ],
        })
      )
    ).toThrow()
  })

  test('a rewrite that names a placeholder the path does not have is refused', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/ws/{workspaceId}/' },
              upstream: 'http://upstream:3000',
              rewrite: '/v1/{otherId}/{rest}',
            },
          ],
        })
      )
    ).toThrow()
  })

  test('a route may name several upstreams', () => {
    const configuration = parseConfig(
      baseConfig({
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: ['http://first:3000', 'http://second:3000'],
          },
        ],
      })
    )
    expect(configuration.routes[0]?.upstream).toEqual(['http://first:3000', 'http://second:3000'])
  })

  test('a list of upstreams may not be empty', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [{ id: 'a', match: { host: '*', path: '/' }, upstream: [] }],
        })
      )
    ).toThrow()
  })

  test('a rewrite that names a placeholder of the path is accepted', () => {
    const configuration = parseConfig(
      baseConfig({
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/ws/{workspaceId}/' },
            upstream: 'http://upstream:3000',
            rewrite: '/v1/{workspaceId}/{rest}',
          },
        ],
      })
    )
    expect(configuration.routes[0]?.rewrite).toBe('/v1/{workspaceId}/{rest}')
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

  test('the policy of the cross site requests comes from the route, then the defaults', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        defaults: { auth: { mode: 'none' }, crossSite: 'strict' },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            crossSite: 'navigation',
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
    expect(snapshot.routes.find((route) => route.id === 'a')!.payload.crossSite).toBe('navigation')
    expect(snapshot.routes.find((route) => route.id === 'b')!.payload.crossSite).toBe('strict')
  })

  test('the policy of the cross site requests is navigation by default', () => {
    const configuration = store()
    configuration.apply(baseConfig())
    expect(configuration.snapshot!.routes[0]!.payload.crossSite).toBe('navigation')
  })

  test('the authorization of the caller comes from the route, then the defaults', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        defaults: { auth: { mode: 'none' }, forwardAuthorization: false },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            forwardAuthorization: true,
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
    expect(snapshot.routes.find((route) => route.id === 'a')!.payload.forwardAuthorization).toBe(
      true
    )
    expect(snapshot.routes.find((route) => route.id === 'b')!.payload.forwardAuthorization).toBe(
      false
    )
  })

  test('the lifetime of a cached decision comes from the route, then the defaults', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        defaults: { auth: { mode: 'none' }, accessCacheTtlMs: 1000 },
        routes: [
          {
            id: 'a',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream:3000',
            accessCacheTtlMs: 0,
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
    // Zero asks the access service for every request: the revocation of
    // that route is immediate.
    expect(snapshot.routes.find((route) => route.id === 'a')!.payload.accessCacheTtlMs).toBe(0)
    expect(snapshot.routes.find((route) => route.id === 'b')!.payload.accessCacheTtlMs).toBe(1000)

    // Nothing is set: the lifetime of the environment is used.
    const withoutDefaults = store()
    withoutDefaults.apply(
      baseConfig({
        routes: [{ id: 'a', match: { host: '*', path: '/' }, upstream: 'http://upstream:3000' }],
      })
    )
    expect(withoutDefaults.snapshot!.routes[0]!.payload.accessCacheTtlMs).toBeUndefined()
  })

  test('an unknown policy of the cross site requests is a configuration error', () => {
    expect(() =>
      parseConfig(
        baseConfig({
          routes: [
            {
              id: 'a',
              match: { host: '*', path: '/' },
              upstream: 'http://upstream:3000',
              crossSite: 'maybe',
            },
          ],
        })
      )
    ).toThrow()
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

describe('the description of the configuration that is running', () => {
  test('the description carries the policy of every route', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'workspace-api',
            match: { host: 'api.example.com', path: '/ws/{workspaceId}/' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'session', workspace: { param: 'workspaceId' } },
            rewrite: '/api/{rest}',
            websocket: true,
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    expect(description.routeCount).toBe(1)
    const route = description.routes[0]!
    expect(route.id).toBe('workspace-api')
    expect(route.host).toBe('api.example.com')
    expect(route.path).toBe('/ws/{workspaceId}/')
    expect(route.rewrite).toBe('/api/{rest}')
    expect(route.auth).toBe('session')
    expect(route.workspace).toBe('workspaceId')
    expect(route.websocket).toBe(true)
    expect(route.upstreams).toEqual(['http://upstream-a:3000'])
  })

  test('a route that accepts an unauthenticated caller is named', () => {
    const configuration = store()
    configuration.apply(baseConfig())
    const description = describeConfiguration(configuration.snapshot!)
    expect(description.warnings.map((warning) => warning.code)).toContain('unauthenticated_route')
  })

  test('a route that authenticates without asking the access service is named', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'api',
            match: { host: '*', path: '/api' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'jwt' },
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    const codes = description.warnings.map((warning) => warning.code)
    expect(codes).toContain('no_workspace_check')
    expect(codes).not.toContain('unauthenticated_route')
  })

  test('a route that asks the access service about itself is not named', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'api',
            match: { host: '*', path: '/api' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'jwt' },
            accessCheck: true,
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    const codes = description.warnings.map((warning) => warning.code)
    // The route asks the access service: it is not a route that
    // authenticates the caller and never checks anything.
    expect(codes).not.toContain('no_workspace_check')
    expect(description.routes[0]?.accessCheck).toBe(true)
  })

  test('a check of the access service needs an authenticated caller', () => {
    const configuration = store()
    const result = configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'api',
            match: { host: '*', path: '/api' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'none' },
            accessCheck: true,
          },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(configuration.lastError?.details.join(' ')).toContain('accessCheck')
  })

  test('the credential of the caller that reaches the upstream is named', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'api',
            match: { host: '*', path: '/api' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'jwt' },
            forwardAuthorization: true,
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    expect(description.warnings.map((warning) => warning.code)).toContain('authorization_forwarded')
  })

  test('a route that accepts a navigation from another site is named', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'app',
            match: { host: '*', path: '/' },
            upstream: 'http://upstream-a:3000',
            auth: { mode: 'session' },
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    expect(description.warnings.map((warning) => warning.code)).toContain('cross_site_allowed')
  })

  test('a route with several upstreams is named', () => {
    const configuration = store()
    configuration.apply(
      baseConfig({
        routes: [
          {
            id: 'api',
            match: { host: '*', path: '/api' },
            upstream: ['http://upstream-a:3000', 'http://upstream-b:3000'],
          },
        ],
      })
    )
    const description = describeConfiguration(configuration.snapshot!)
    expect(description.warnings.map((warning) => warning.code)).toContain('limited_failover')
    expect(description.routes[0]!.upstreams).toHaveLength(2)
  })
})
