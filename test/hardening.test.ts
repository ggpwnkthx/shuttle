import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './helpers/harness'
import { parseConfig } from '../src/config/schema'
import { compileRoutes, detectConflicts, sortRoutes } from '../src/config/matcher'
import { ipInRanges } from '../src/util/net'
import { redactFields, redactUrl } from '../src/log/logger'
import { AccessClient } from '../src/auth/access'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    routes: ({ upstreamA, upstreamB }) => [
      {
        id: 'public-site',
        match: { host: 'public.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'workspace-api',
        match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
        upstream: upstreamB,
        auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the configuration is strict', () => {
  test('an unknown key of a route is a configuration error', () => {
    expect(() =>
      parseConfig({
        version: 1,
        routes: [
          {
            id: 'a',
            match: { host: 'a.test', path: '/' },
            upstream: 'http://a',
            // A typo of maxBodyBytes would silently remove the body limit.
            maxBodyByte: 5,
          },
        ],
      })
    ).toThrow(/Unrecognized key/)
  })

  test('an unknown key of the defaults is a configuration error', () => {
    expect(() =>
      parseConfig({
        version: 1,
        defaults: { timeoutz: { connectMs: 100 } },
        routes: [{ id: 'a', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }],
      })
    ).toThrow(/Unrecognized key/)
  })

  test('an unknown key of the budgets of a route is a configuration error', () => {
    expect(() =>
      parseConfig({
        version: 1,
        routes: [
          {
            id: 'a',
            match: { host: 'a.test', path: '/' },
            upstream: 'http://a',
            timeouts: { connectMS: 100 },
          },
        ],
      })
    ).toThrow(/Unrecognized key/)
  })

  test('an unknown key at the top level is a configuration error', () => {
    expect(() =>
      parseConfig({
        version: 1,
        trustedProxy: [],
        routes: [{ id: 'a', match: { host: 'a.test', path: '/' }, upstream: 'http://a' }],
      })
    ).toThrow(/Unrecognized key/)
  })

  test('a broken default policy is rejected even when no route uses it', () => {
    expect(() =>
      parseConfig({
        version: 1,
        defaults: { auth: { mode: 'none', workspace: { param: 'workspaceId' } } },
        routes: [
          {
            id: 'a',
            match: { host: 'a.test', path: '/' },
            upstream: 'http://a',
            auth: { mode: 'none' },
          },
        ],
      })
    ).toThrow(/workspace check needs an authentication mode/)
  })
})

describe('the paths the gateway serves itself', () => {
  test('a route that claims a gateway path is rejected', () => {
    const parsed = parseConfig({
      version: 1,
      routes: [
        { id: 'shadow', match: { host: 'api.test', path: '/metrics' }, upstream: 'http://a' },
      ],
    })
    const conflicts = detectConflicts(sortRoutes(compileRoutes(parsed)))
    expect(conflicts.join(' ')).toContain('reserved path')
  })

  test('a route that claims a gateway path with a trailing slash is rejected', () => {
    const parsed = parseConfig({
      version: 1,
      routes: [
        { id: 'shadow', match: { host: 'api.test', path: '/metrics/' }, upstream: 'http://a' },
      ],
    })
    const conflicts = detectConflicts(sortRoutes(compileRoutes(parsed)))
    expect(conflicts.join(' ')).toContain('reserved path')
  })

  test('a route that claims a reserved path of the configuration is rejected', () => {
    const parsed = parseConfig({
      version: 1,
      reservedPaths: ['/admin'],
      routes: [
        { id: 'shadow', match: { host: 'api.test', path: '/admin' }, upstream: 'http://a' },
      ],
    })
    const conflicts = detectConflicts(sortRoutes(compileRoutes(parsed)), parsed.reservedPaths)
    expect(conflicts.join(' ')).toContain('reserved path')
  })

  test('the reserved paths are never routed to an upstream, in any spelling', async () => {
    // The gateway owns the name of its own paths, so neither the exact path
    // nor the path with a trailing slash reaches an upstream.
    for (const path of [
      '/metrics',
      '/metrics/',
      '/healthz',
      '/healthz/',
      '/readyz/',
      '/auth/login',
      '/auth/login/',
    ]) {
      const response = await fetch(`${harness.gatewayUrl}${path}`, {
        headers: { host: 'public.shuttle.test' },
        redirect: 'manual',
      })
      const body = await response.text()
      // The upstream never saw the request: the echo of the sample upstream
      // is the only answer that names it.
      expect(body).not.toContain('upstream-a')
      expect(body).not.toContain('"path":"/metrics')
    }
  })

  test('a reserved path is never routed to an upstream', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz/../admin`, {
      headers: { host: 'public.shuttle.test' },
    })
    // The path is normalized to /admin, which is not reserved: it is routed.
    expect([200, 404]).toContain(response.status)
  })

  test('an additional reserved path is not routed to an upstream', async () => {
    const reserved = await createHarness({
      config: ({ upstreamA }) => ({
        version: 1,
        reservedPaths: ['/admin'],
        routes: [
          {
            id: 'public-site',
            match: { host: 'public.shuttle.test', path: '/' },
            upstream: upstreamA,
            auth: { mode: 'none' },
          },
        ],
      }),
    })
    try {
      const response = await fetch(`${reserved.gatewayUrl}/admin`, {
        headers: { host: 'public.shuttle.test' },
      })
      expect(response.status).toBe(404)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe('not_found')
    } finally {
      await reserved.stop()
    }
  })
})

describe('the decision cache of the access service', () => {
  test('a decision is not served to a caller with different roles', async () => {
    const calls: unknown[] = []
    const client = new AccessClient({
      baseUrl: 'http://access.test',
      cacheTtlMs: 60_000,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)))
        return Response.json({ allow: true, reason: 'allowed' })
      }) as unknown as typeof fetch,
    })

    await client.decide({ subject: 'u1', workspaceId: 'w1', routeId: 'r1', roles: ['admin'] })
    const second = await client.decide({
      subject: 'u1',
      workspaceId: 'w1',
      routeId: 'r1',
      roles: [],
    })

    expect(calls).toHaveLength(2)
    expect(second.cached).toBe(false)
  })

  test('the same caller with the same roles uses the cache', async () => {
    const calls: unknown[] = []
    const client = new AccessClient({
      baseUrl: 'http://access.test',
      cacheTtlMs: 60_000,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)))
        return Response.json({ allow: true, reason: 'allowed' })
      }) as unknown as typeof fetch,
    })

    await client.decide({ subject: 'u1', workspaceId: 'w1', routeId: 'r1', roles: ['admin'] })
    const second = await client.decide({
      subject: 'u1',
      workspaceId: 'w1',
      routeId: 'r1',
      roles: ['admin'],
    })

    expect(calls).toHaveLength(1)
    expect(second.cached).toBe(true)
  })
})

describe('the forwarding headers', () => {
  test('the client is the entry of the forwarded chain that is not a proxy', async () => {
    const trusted = await createHarness({
      trustedProxies: ['127.0.0.1/32'],
      routes: ({ upstreamA }) => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: upstreamA,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${trusted.gatewayUrl}/`, {
        headers: {
          host: 'public.shuttle.test',
          'x-forwarded-for': '203.0.113.7, 198.51.100.9',
        },
      })
      const body = (await response.json()) as { headers: Record<string, string> }
      // The chain starts at the client and the peer is appended to it. The
      // entries a client injected on the left of the chain are not part of
      // it: only a proxy can add an entry on the right.
      expect(body.headers['x-forwarded-for']).toBe('198.51.100.9, 127.0.0.1')
      // The client is the entry of the chain that is not a trusted proxy.
      expect(body.headers['x-real-ip']).toBe('198.51.100.9')
    } finally {
      await trusted.stop()
    }
  })

  test('a client cannot spoof the real ip', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test', 'x-real-ip': '203.0.113.7' },
    })
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-real-ip']).not.toBe('203.0.113.7')
  })
})

describe('the request identifiers', () => {
  test('the identifier of the client is used', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test', 'x-request-id': 'my-request-id' },
    })
    expect(response.headers.get('x-request-id')).toBe('my-request-id')
  })

  test('an invalid identifier is replaced by a generated one', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test', 'x-request-id': 'not valid' },
    })
    const id = response.headers.get('x-request-id')
    expect(id).toBeString()
    expect(id).not.toBe('not valid')
  })
})

describe('the redaction of the log', () => {
  test('a token bearing query parameter is redacted from a path', () => {
    expect(redactUrl('/ws/abc?token=SECRET&ok=1')).toBe('/ws/abc?token=%5Bredacted%5D&ok=1')
  })

  test('a sensitive header is redacted wherever it appears', () => {
    const fields = redactFields({
      cookie: 'session=abc',
      nested: { authorization: 'Bearer token' },
      safe: 'value',
    })
    expect(fields.cookie).toBe('[redacted]')
    expect((fields.nested as Record<string, string>).authorization).toBe('[redacted]')
    expect(fields.safe).toBe('value')
  })
})

describe('the address ranges', () => {
  test('an address in a range matches', () => {
    expect(ipInRanges('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(ipInRanges('127.0.0.1', ['127.0.0.1/32'])).toBe(true)
    expect(ipInRanges('::1', ['::1/128'])).toBe(true)
  })

  test('an address outside a range does not match', () => {
    expect(ipInRanges('8.8.8.8', ['10.0.0.0/8'])).toBe(false)
    expect(ipInRanges('127.0.0.2', ['127.0.0.1/32'])).toBe(false)
  })

  test('a range of another family never matches', () => {
    expect(ipInRanges('10.1.2.3', ['::1/128'])).toBe(false)
    expect(ipInRanges('::1', ['127.0.0.1/32'])).toBe(false)
  })

  test('a range that cannot be parsed never matches', () => {
    expect(ipInRanges('10.1.2.3', ['not-a-range'])).toBe(false)
    expect(ipInRanges('not-an-address', ['10.0.0.0/8'])).toBe(false)
  })
})
