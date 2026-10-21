import { describe, expect, test } from 'bun:test'
import { MemoryDecisionCache } from './adapters'
import {
  AccessClient,
  authFailureReason,
  decisionKey,
  isUuid,
  validateWorkspace,
  type AccessTransport,
  type CachedDecision,
} from './index'

/** A transport that answers what the test needs. */
function transport(options: {
  status?: number
  body?: string
  error?: Error
  onRequest?: (body: string, headers: Record<string, string>) => void
}): AccessTransport {
  return {
    async post(request) {
      options.onRequest?.(request.body, request.headers)
      if (options.error) throw options.error
      return { status: options.status ?? 200, body: options.body ?? '{"allow":true}' }
    },
  }
}

/** A client with a cache of the decisions. */
function client(
  options: {
    status?: number
    body?: string
    error?: Error
    cacheTtlMs?: number
    onRequest?: (body: string, headers: Record<string, string>) => void
  } = {}
): { client: AccessClient; cache: MemoryDecisionCache } {
  const cache = new MemoryDecisionCache()
  return {
    cache,
    client: new AccessClient({
      baseUrl: 'http://access.test',
      token: 'the-token',
      transport: transport(options),
      cache,
      cacheTtlMs: options.cacheTtlMs ?? 5_000,
    }),
  }
}

describe('the identifier of a workspace', () => {
  test('a uuid is recognized', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
  })

  test('a missing identifier is refused', () => {
    expect(validateWorkspace(undefined, { requireUuid: true })).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  test('an identifier that is not a uuid is refused when it has to be one', () => {
    expect(validateWorkspace('abc', { requireUuid: true })).toEqual({
      ok: false,
      reason: 'not_a_uuid',
    })
    expect(validateWorkspace('abc', { requireUuid: false })).toEqual({
      ok: true,
      workspaceId: 'abc',
    })
  })
})

describe('the request of a decision', () => {
  test('it carries the subject, the workspace, the route and the roles', async () => {
    let body = ''
    let headers: Record<string, string> = {}
    const { client: access } = client({
      onRequest: (requestBody, requestHeaders) => {
        body = requestBody
        headers = requestHeaders
      },
    })
    await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'workspace-api',
      roles: ['admin'],
    })
    expect(JSON.parse(body)).toEqual({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'workspace-api',
      roles: ['admin'],
    })
    expect(headers.authorization).toBe('Bearer the-token')
  })

  test('the roles are sent in the order of the caller', async () => {
    let body = ''
    const { client: access } = client({ onRequest: (requestBody) => (body = requestBody) })
    await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
      roles: ['b', 'a'],
    })
    expect(JSON.parse(body).roles).toEqual(['b', 'a'])
  })
})

describe('the decisions of the access service', () => {
  test('an explicit decision allows the caller', async () => {
    const { client: access } = client({ body: '{"allow":true,"reason":"allowed"}' })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(true)
    expect(decision.kind).toBe('allowed')
    expect(decision.cached).toBe(false)
  })

  test('an explicit decision denies the caller', async () => {
    const { client: access } = client({
      body: '{"allow":false,"reason":"the subject does not have the role"}',
    })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(false)
    expect(decision.kind).toBe('denied')
    expect(decision.reason).toContain('role')
  })

  test('a malformed answer is the unavailability of the service', async () => {
    const { client: access } = client({ body: '{"allow":"yes"}' })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(false)
    expect(decision.kind).toBe('unavailable')
  })

  test('an answer that is not json is the unavailability of the service', async () => {
    const { client: access } = client({ body: 'not json' })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(false)
    expect(decision.kind).toBe('unavailable')
  })

  test('a status that is not a success is the unavailability of the service', async () => {
    const { client: access } = client({ status: 503, body: '{"allow":true}' })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(false)
    expect(decision.kind).toBe('unavailable')
  })

  test('a service that cannot be reached is the unavailability of the service', async () => {
    const { client: access } = client({ error: new Error('the connection is closed') })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    expect(decision.allow).toBe(false)
    expect(decision.kind).toBe('unavailable')
  })

  test('the unavailability of the service is never cached', async () => {
    let calls = 0
    const { client: access } = client({
      error: new Error('the connection is closed'),
      onRequest: () => {
        calls += 1
      },
    })
    const request = { subject: 'user-1', workspaceId: 'workspace-1', routeId: 'route' }
    expect((await access.decide(request)).kind).toBe('unavailable')
    expect((await access.decide(request)).kind).toBe('unavailable')
    // The service is asked again: the failure is not a decision.
    expect(calls).toBe(2)
  })
})

describe('the cache of the decisions', () => {
  test('a decision is reused during its lifetime', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":true}',
      onRequest: () => {
        calls += 1
      },
    })
    const request = {
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
      roles: ['a'],
    }
    expect((await access.decide(request)).cached).toBe(false)
    const second = await access.decide(request)
    expect(second.cached).toBe(true)
    expect(calls).toBe(1)
  })

  test('the roles are part of the key of a decision', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":true}',
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide({ subject: 'user-1', workspaceId: 'w', routeId: 'route', roles: ['admin'] })
    await access.decide({ subject: 'user-1', workspaceId: 'w', routeId: 'route', roles: ['admin'] })
    expect(calls).toBe(1)
    await access.decide({ subject: 'user-1', workspaceId: 'w', routeId: 'route', roles: [] })
    expect(calls).toBe(2)
  })

  test('a route that asks for no cache asks the service for every request', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":true}',
      onRequest: () => {
        calls += 1
      },
    })
    const request = {
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
      roles: ['a'],
    }
    // The lifetime of the route is zero: the revocation on that route is
    // immediate, so the service is asked for every request.
    expect((await access.decide(request, { cacheTtlMs: 0 })).cached).toBe(false)
    expect((await access.decide(request, { cacheTtlMs: 0 })).cached).toBe(false)
    expect(calls).toBe(2)
  })

  test('the lifetime of the route replaces the lifetime of the deployment', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":true}',
      cacheTtlMs: 60_000,
      onRequest: () => {
        calls += 1
      },
    })
    const request = {
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
      roles: ['a'],
    }
    expect((await access.decide(request, { cacheTtlMs: 0 })).cached).toBe(false)
    // The decision of the route was not cached, so the next request asks
    // the service again.
    expect((await access.decide(request, { cacheTtlMs: 0 })).cached).toBe(false)
    expect(calls).toBe(2)
  })

  test('the order of the roles is not part of the key', () => {
    const first = decisionKey({ subject: 'u', workspaceId: 'w', routeId: 'r', roles: ['a', 'b'] })
    const second = decisionKey({ subject: 'u', workspaceId: 'w', routeId: 'r', roles: ['b', 'a'] })
    expect(first).toBe(second)
  })

  test('a failure of the service is not cached', async () => {
    let calls = 0
    const { client: access } = client({
      error: new Error('the connection is closed'),
      onRequest: () => {
        calls += 1
      },
    })
    const request = { subject: 'user-1', workspaceId: 'workspace-1', routeId: 'route' }
    expect((await access.decide(request)).allow).toBe(false)
    expect((await access.decide(request)).allow).toBe(false)
    // The service is asked again: the failure is not a decision.
    expect(calls).toBe(2)
  })

  test('a cache that is not available asks the service again', async () => {
    let calls = 0
    const cache: {
      get: () => Promise<CachedDecision | null>
      set: () => Promise<void>
      delete: () => Promise<void>
      close: () => Promise<void>
    } = {
      async get() {
        throw new Error('the cache is not available')
      },
      async set() {
        throw new Error('the cache is not available')
      },
      async delete() {},
      async close() {},
    }
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: transport({
        body: '{"allow":true}',
        onRequest: () => {
          calls += 1
        },
      }),
      cache,
    })
    const decision = await access.decide({
      subject: 'user-1',
      workspaceId: 'workspace-1',
      routeId: 'route',
    })
    // The cache is not available: the decision is asked for, and the answer
    // of the service is the answer of the request.
    expect(decision.allow).toBe(true)
    expect(calls).toBe(1)
  })

  test('a burst of requests for the same decision asks the service once', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = new MemoryDecisionCache()
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: {
        async post() {
          calls += 1
          await gate
          return { status: 200, body: '{"allow":true}' }
        },
      },
      cache,
    })
    const request = { subject: 'user-1', workspaceId: 'workspace-1', routeId: 'route' }

    // The cache is empty — the lifetime of the decision is over — and the
    // requests arrive at the same time: the service is asked once.
    const first = access.decide(request)
    const second = access.decide(request)
    const third = access.decide(request)
    release()
    const decisions = await Promise.all([first, second, third])
    expect(calls).toBe(1)
    for (const decision of decisions) {
      expect(decision.allow).toBe(true)
    }
  })

  test('the calls that are in flight are released', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":true}',
      onRequest: () => {
        calls += 1
      },
    })
    const request = { subject: 'user-1', workspaceId: 'workspace-1', routeId: 'route' }
    await access.decide(request)
    // The decision is cached, so the second call does not ask the service.
    await access.decide(request)
    expect(calls).toBe(1)
  })

  test('the cache of the process is bounded', async () => {
    const cache = new MemoryDecisionCache({ maxEntries: 10 })
    for (let index = 0; index < 100; index++) {
      await cache.set(
        `key-${index}`,
        { allow: true, kind: 'allowed', reason: '', decidedAt: Date.now() },
        5_000
      )
    }
    expect(cache.size).toBeLessThanOrEqual(10)
  })
})

describe('the reason of a denial', () => {
  test('a denial that is about a role is counted as such', () => {
    expect(authFailureReason('the subject does not have the role admin')).toBe('missing_role')
    expect(authFailureReason('the subject does not exist')).toBe('access_denied')
  })
})
