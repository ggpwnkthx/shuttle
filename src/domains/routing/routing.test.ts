import { describe, expect, test } from 'bun:test'
import {
  claimsReservedPath,
  compileRoute,
  detectConflicts,
  matchRoute,
  normalizeHost,
  sortRoutes,
  type CompiledRoute,
  type RouteMatchDefinition,
} from './index'

/** Prepares a route for the matching. */
function route(definition: RouteMatchDefinition): CompiledRoute<string> {
  return compileRoute(definition, definition.id)
}

/** The routes, sorted the way the configuration sorts them. */
function table(definitions: RouteMatchDefinition[]): CompiledRoute<string>[] {
  return sortRoutes(definitions.map(route))
}

describe('the host of a request', () => {
  test('the port and the trailing dot are not part of the name', () => {
    expect(normalizeHost('API.Example.COM:8443')).toBe('api.example.com')
    expect(normalizeHost('api.example.com.')).toBe('api.example.com')
    expect(normalizeHost('  api.example.com  ')).toBe('api.example.com')
  })

  test('an address of ipv6 keeps its brackets out of the name', () => {
    expect(normalizeHost('[2001:db8::1]:8080')).toBe('2001:db8::1')
  })
})

describe('the matching of a route', () => {
  test('an exact host matches itself', () => {
    const routes = table([{ id: 'a', host: 'api.example.com', path: '/' }])
    expect(matchRoute(routes, 'api.example.com', '/')?.route.id).toBe('a')
    expect(matchRoute(routes, 'other.example.com', '/')).toBeNull()
  })

  test('a wildcard matches the subdomains but not the domain itself', () => {
    const routes = table([{ id: 'a', host: '*.example.com', path: '/' }])
    expect(matchRoute(routes, 'api.example.com', '/')?.route.id).toBe('a')
    expect(matchRoute(routes, 'example.com', '/')).toBeNull()
  })

  test('the catch-all matches every host', () => {
    const routes = table([{ id: 'a', host: '*', path: '/' }])
    expect(matchRoute(routes, 'anything.example.com', '/')?.route.id).toBe('a')
  })

  test('the port of the request does not change the match', () => {
    const routes = table([{ id: 'a', host: 'api.example.com', path: '/' }])
    expect(matchRoute(routes, 'api.example.com:8443', '/')?.route.id).toBe('a')
  })

  test('a template matches the prefix of a path', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc')?.params.id).toBe('abc')
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.params.id).toBe('abc')
    expect(matchRoute(routes, 'api.example.com', '/other')).toBeNull()
  })

  test('the value of a placeholder is percent decoded', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/a%20b')?.params.id).toBe('a b')
  })

  test('a placeholder that cannot be decoded leaves the request unmatched', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/%E0%A4%A')).toBeNull()
  })

  test('the matched prefix is the part of the path the route matched', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.prefix).toBe('/ws/abc')
  })
})

describe('the rewrite of the path of a route', () => {
  test('a route that does not rewrite forwards the path of the request', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.path).toBe('/ws/abc/assets')
  })

  test('the rest of the path is the part that follows the prefix', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/', rewrite: '/{rest}' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.path).toBe('/assets')
    expect(matchRoute(routes, 'api.example.com', '/ws/abc')?.path).toBe('/')
  })

  test('a rewrite writes the values of the placeholders of the path', () => {
    const routes = table([
      { id: 'a', host: '*', path: '/ws/{id}/', rewrite: '/v1/workspaces/{id}/{rest}' },
    ])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.path).toBe(
      '/v1/workspaces/abc/assets'
    )
  })

  test('a rewrite without the rest does not forward the rest of the path', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/', rewrite: '/v1' }])
    expect(matchRoute(routes, 'api.example.com', '/ws/abc/assets')?.path).toBe('/v1')
  })

  test('the encoding of the values is not touched', () => {
    const routes = table([{ id: 'a', host: '*', path: '/ws/{id}/', rewrite: '/{id}/{rest}' }])
    // The value the caller sent is the one the upstream receives.
    expect(matchRoute(routes, 'api.example.com', '/ws/a%20b/assets')?.path).toBe('/a%20b/assets')
  })

  test('a rewrite of the root of a route keeps the whole path', () => {
    const routes = table([{ id: 'a', host: '*', path: '/', rewrite: '/{rest}' }])
    expect(matchRoute(routes, 'api.example.com', '/assets')?.path).toBe('/assets')
    expect(matchRoute(routes, 'api.example.com', '/')?.path).toBe('/')
  })

  test('the rest may only be the last segment of a rewrite', () => {
    expect(() =>
      compileRoute({ id: 'a', host: '*', path: '/ws/{id}/', rewrite: '/{rest}/more' }, 'a')
    ).toThrow(/rest/)
  })
})

describe('the precedence of the routes', () => {
  test('an exact host wins over a wildcard and over the catch-all', () => {
    const routes = table([
      { id: 'catch-all', host: '*', path: '/' },
      { id: 'wildcard', host: '*.example.com', path: '/' },
      { id: 'exact', host: 'api.example.com', path: '/' },
    ])
    expect(matchRoute(routes, 'api.example.com', '/')?.route.id).toBe('exact')
    expect(matchRoute(routes, 'other.example.com', '/')?.route.id).toBe('wildcard')
    expect(matchRoute(routes, 'other.test', '/')?.route.id).toBe('catch-all')
  })

  test('the longer literal prefix wins', () => {
    const routes = table([
      { id: 'short', host: '*', path: '/ws/' },
      { id: 'long', host: '*', path: '/ws/assets/' },
    ])
    expect(matchRoute(routes, 'api.example.com', '/ws/assets/logo.png')?.route.id).toBe('long')
  })

  test('the route with more segments wins', () => {
    const routes = table([
      { id: 'few', host: '*', path: '/{a}' },
      { id: 'many', host: '*', path: '/{a}/{b}' },
    ])
    expect(matchRoute(routes, 'api.example.com', '/one/two')?.route.id).toBe('many')
  })

  test('the id breaks the last tie', () => {
    const routes = table([
      { id: 'b-route', host: '*', path: '/{a}' },
      { id: 'a-route', host: '*', path: '/{a}' },
    ])
    expect(matchRoute(routes, 'api.example.com', '/one')?.route.id).toBe('a-route')
  })
})

describe('the conflicts of a route table', () => {
  test('two routes with the same id conflict', () => {
    const routes = table([
      { id: 'same', host: 'a.example.com', path: '/one' },
      { id: 'same', host: 'b.example.com', path: '/two' },
    ])
    expect(detectConflicts(routes)).toContain('duplicate route id "same"')
  })

  test('two routes that match the same requests conflict', () => {
    const routes = table([
      { id: 'a', host: 'api.example.com', path: '/ws/{id}/' },
      { id: 'b', host: 'api.example.com', path: '/ws/{other}/' },
    ])
    expect(detectConflicts(routes)).toHaveLength(1)
  })

  test('routes with a different host do not conflict', () => {
    const routes = table([
      { id: 'a', host: 'api.example.com', path: '/ws/{id}/' },
      { id: 'b', host: 'other.example.com', path: '/ws/{id}/' },
    ])
    expect(detectConflicts(routes)).toEqual([])
  })

  test('a route that claims a reserved path is reported', () => {
    const routes = table([{ id: 'a', host: '*', path: '/metrics' }])
    expect(claimsReservedPath(routes[0]!, ['/metrics'])).toBe(true)
    expect(claimsReservedPath(routes[0]!, ['/healthz'])).toBe(false)
  })

  test('the trailing slash does not hide a reserved path', () => {
    const routes = table([{ id: 'a', host: '*', path: '/metrics/' }])
    expect(claimsReservedPath(routes[0]!, ['/metrics'])).toBe(true)
  })
})
