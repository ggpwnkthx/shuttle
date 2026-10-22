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
    staleGraceMs?: number
    breaker?: { failures?: number; cooldownMs?: number }
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
      staleGraceMs: options.staleGraceMs ?? 0,
      breaker: options.breaker,
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

  test('a role containing a comma does not reuse the decision for separate roles', async () => {
    let calls = 0
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      cache: new MemoryDecisionCache(),
      transport: {
        async post(request) {
          calls += 1
          const { roles } = JSON.parse(request.body) as { roles: string[] }
          return { status: 200, body: JSON.stringify({ allow: roles.includes('admin') }) }
        },
      },
    })
    const request = {
      subject: 'user-1',
      workspaceId: 'w',
      routeId: 'route',
      roles: ['user', 'admin'],
    }
    try {
      expect((await access.decide(request)).allow).toBe(true)
      const reordered = await access.decide({ ...request, roles: ['admin', 'user'] })
      expect(reordered.allow).toBe(true)
      expect(reordered.cached).toBe(true)

      const otherRoles = { ...request, roles: ['admin,user'] }
      const denied = await access.decide(otherRoles)
      expect(denied.allow).toBe(false)
      expect(denied.cached).toBe(false)
      const cachedDenial = await access.decide(otherRoles)
      expect(cachedDenial.allow).toBe(false)
      expect(cachedDenial.cached).toBe(true)
      expect(calls).toBe(2)
      expect(request.roles).toEqual(['user', 'admin'])
    } finally {
      await access.close()
    }
  })

  test('an empty role is distinct from having no roles', () => {
    const request = { subject: 'u', workspaceId: 'w', routeId: 'r' }
    expect(decisionKey({ ...request, roles: [''] })).not.toBe(
      decisionKey({ ...request, roles: [] })
    )
    expect(decisionKey(request)).toBe(decisionKey({ ...request, roles: [] }))
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

  test('a route without a workspace has its own decisions', () => {
    const withWorkspace = decisionKey({ subject: 'u', workspaceId: 'w', routeId: 'r' })
    const without = decisionKey({ subject: 'u', routeId: 'r' })
    expect(withWorkspace).not.toBe(without)
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
  const request = {
    subject: 'user-1',
    workspaceId: 'workspace-1',
    routeId: 'route',
    roles: ['a'],
  }

  test('the code of the reason is what the metric counts', () => {
    expect(authFailureReason('missing_role')).toBe('missing_role')
    expect(authFailureReason('workspace_not_found')).toBe('access_denied')
    expect(authFailureReason('policy_denied')).toBe('access_denied')
    expect(authFailureReason('access_denied')).toBe('access_denied')
  })

  test('a code that is not about a role is counted as a denial', () => {
    expect(authFailureReason('missing_role', 'the subject does not have the role')).toBe(
      'missing_role'
    )
    expect(authFailureReason('policy_denied', 'the subject does not have the role')).toBe(
      'access_denied'
    )
  })

  test('the code of the reason of a denial is read', async () => {
    const { client: access } = client({
      body: '{"allow":false,"reason":"the subject does not have the role","reasonCode":"missing_role"}',
    })
    const decision = await access.decide(request)
    expect(decision.kind).toBe('denied')
    expect(decision.reasonCode).toBe('missing_role')
  })

  test('a code the gateway does not know is ignored', async () => {
    const { client: access } = client({
      body: '{"allow":false,"reason":"denied","reasonCode":"something_else"}',
    })
    const decision = await access.decide(request)
    expect(decision.kind).toBe('denied')
    expect(decision.reasonCode).toBeUndefined()
  })

  test('a service that sends no code is counted with the legacy rule', () => {
    // The behavior of the `1.0` release: a service that sends no code is
    // counted with the text of its reason. The rule is deprecated, and it
    // is kept so that a deployment written against the `1.0` keeps
    // working without a change.
    expect(authFailureReason(undefined, 'the subject does not have the role admin')).toBe(
      'missing_role'
    )
    expect(authFailureReason(undefined, 'the subject does not exist')).toBe('access_denied')
    expect(authFailureReason(undefined)).toBe('access_denied')
  })
})

describe('the grace of an outage of the access service', () => {
  const request = {
    subject: 'user-1',
    workspaceId: 'workspace-1',
    routeId: 'route',
    roles: ['a'],
  }

  /** A client whose service is down and whose cache holds a decision. */
  async function withOldDecision(
    decision: { allow: boolean },
    options: { cacheTtlMs: number; staleGraceMs: number }
  ): Promise<{
    client: AccessClient
    stale: { routeId: string; ageMs: number }[]
  }> {
    const cache = new MemoryDecisionCache()
    const key = decisionKey(request)
    await cache.set(
      key,
      {
        allow: decision.allow,
        kind: decision.allow ? 'allowed' : 'denied',
        reason: decision.allow ? 'allowed' : 'denied',
        // The decision was taken ten seconds ago: it is older than the
        // lifetime of the deployment and inside the grace.
        decidedAt: Date.now() - 10_000,
      },
      600_000
    )
    const stale: { routeId: string; ageMs: number }[] = []
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: transport({ error: new Error('the connection is refused') }),
      cache,
      cacheTtlMs: options.cacheTtlMs,
      staleGraceMs: options.staleGraceMs,
      onStale: (routeId, ageMs) => stale.push({ routeId, ageMs }),
    })
    return { client: access, stale }
  }

  test('without a grace an outage of the service is an outage', async () => {
    const { client: access } = await withOldDecision(
      { allow: true },
      { cacheTtlMs: 1_000, staleGraceMs: 0 }
    )
    const decision = await access.decide(request)
    expect(decision.kind).toBe('unavailable')
    expect(decision.stale).toBe(false)
  })

  test('a decision that is too old is asked for again', async () => {
    let calls = 0
    const cache = new MemoryDecisionCache()
    const key = decisionKey(request)
    await cache.set(
      key,
      { allow: true, kind: 'allowed', reason: '', decidedAt: Date.now() - 60_000 },
      600_000
    )
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: transport({
        body: '{"allow":true}',
        onRequest: () => {
          calls += 1
        },
      }),
      cache,
      cacheTtlMs: 1_000,
      staleGraceMs: 30_000,
    })
    const decision = await access.decide(request)
    // The service was asked: the decision was too old to be served, and it
    // answered.
    expect(calls).toBe(1)
    expect(decision.allow).toBe(true)
    expect(decision.stale).toBe(false)
  })

  test('the last decision is served while the service is down', async () => {
    const { client: access, stale } = await withOldDecision(
      { allow: true },
      { cacheTtlMs: 1_000, staleGraceMs: 30_000 }
    )
    const decision = await access.decide(request)
    expect(decision.allow).toBe(true)
    expect(decision.kind).toBe('allowed')
    expect(decision.stale).toBe(true)
    expect(stale).toHaveLength(1)
    expect(stale[0]?.routeId).toBe('route')
  })

  test('a stale decision that is older than the grace is not served', async () => {
    const { client: access } = await withOldDecision(
      { allow: true },
      { cacheTtlMs: 1_000, staleGraceMs: 1_000 }
    )
    // The decision is a minute old and the grace is a second: it is
    // neither fresh nor stale enough to be served.
    const decision = await access.decide(request)
    expect(decision.kind).toBe('unavailable')
  })

  test('a stale denial is not served: the outage stays visible', async () => {
    const { client: access } = await withOldDecision(
      { allow: false },
      { cacheTtlMs: 1_000, staleGraceMs: 30_000 }
    )
    const decision = await access.decide(request)
    expect(decision.kind).toBe('unavailable')
    expect(decision.stale).toBe(false)
  })

  test('a fresh decision is never stale', async () => {
    const { client: access } = await withOldDecision(
      { allow: true },
      { cacheTtlMs: 1_000, staleGraceMs: 30_000 }
    )
    // The revalidation of an open connection asks for a fresh decision: a
    // connection whose access was revoked has to be closed, and a stale
    // decision would keep it open.
    const decision = await access.decide(request, { fresh: true })
    expect(decision.kind).toBe('unavailable')
    expect(decision.stale).toBe(false)
  })

  test('the grace of the route replaces the grace of the deployment', async () => {
    const cache = new MemoryDecisionCache()
    const key = decisionKey(request)
    await cache.set(
      key,
      { allow: true, kind: 'allowed', reason: '', decidedAt: Date.now() - 2_000 },
      600_000
    )
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: transport({ error: new Error('the connection is refused') }),
      cache,
      cacheTtlMs: 1_000,
      staleGraceMs: 60_000,
    })
    // The grace of the route is zero: the outage is an outage.
    expect((await access.decide(request, { staleGraceMs: 0 })).kind).toBe('unavailable')
    // The grace of the deployment is used when the route says nothing.
    expect((await access.decide(request)).kind).toBe('allowed')
  })
})

describe('the breaker of the access service', () => {
  const request = {
    subject: 'user-1',
    workspaceId: 'workspace-1',
    routeId: 'route',
    roles: ['a'],
  }

  test('the service is called until it failed enough times', async () => {
    let calls = 0
    const { client: access } = client({
      error: new Error('the connection is refused'),
      breaker: { failures: 3, cooldownMs: 60_000 },
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide(request)
    await access.decide(request)
    await access.decide(request)
    expect(calls).toBe(3)
    // The breaker is open now: the service is not called any more.
    await access.decide(request)
    expect(calls).toBe(3)
  })

  test('a request that is short circuited is answered at once', async () => {
    let calls = 0
    const { client: access } = client({
      error: new Error('the connection is refused'),
      breaker: { failures: 1, cooldownMs: 60_000 },
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide(request)
    const started = Date.now()
    const decision = await access.decide(request)
    // The service is not called, so the request does not wait for the
    // budget of the call.
    expect(Date.now() - started).toBeLessThan(100)
    expect(calls).toBe(1)
    expect(decision.kind).toBe('unavailable')
    expect(decision.allow).toBe(false)
    expect(decision.shortCircuited).toBe(true)
  })

  test('the breaker only refuses: it never lets a caller in', async () => {
    const { client: access } = client({
      error: new Error('the connection is refused'),
      breaker: { failures: 1, cooldownMs: 60_000 },
    })
    await access.decide(request)
    const decision = await access.decide(request)
    expect(decision.allow).toBe(false)
  })

  test('the grace of an outage still applies while the breaker is open', async () => {
    const cache = new MemoryDecisionCache()
    const key = decisionKey(request)
    await cache.set(
      key,
      { allow: true, kind: 'allowed', reason: '', decidedAt: Date.now() - 2_000 },
      600_000
    )
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: transport({ error: new Error('the connection is refused') }),
      cache,
      cacheTtlMs: 1_000,
      staleGraceMs: 60_000,
      breaker: { failures: 1, cooldownMs: 60_000 },
    })
    await access.decide(request)
    // The service is not called any more, and the decision that allows the
    // caller is still inside the grace: it is served.
    const decision = await access.decide(request)
    expect(decision.allow).toBe(true)
    expect(decision.stale).toBe(true)
  })

  test('a denial does not open the breaker', async () => {
    let calls = 0
    const { client: access } = client({
      body: '{"allow":false,"reason":"denied"}',
      // The decision is not cached: every request asks the service.
      cacheTtlMs: 0,
      breaker: { failures: 1, cooldownMs: 60_000 },
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide(request)
    await access.decide(request)
    await access.decide(request)
    // The service answered every time: it is not called less.
    expect(calls).toBe(3)
  })

  test('a malformed request does not open the breaker', async () => {
    let calls = 0
    const { client: access } = client({
      // A `400` is the gateway's own fault: a bug in the gateway must not
      // refuse every caller of the deployment by opening the breaker.
      status: 400,
      body: '{"error":"bad_request"}',
      breaker: { failures: 1, cooldownMs: 60_000 },
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide(request)
    await access.decide(request)
    expect(calls).toBe(2)
  })

  test('the breaker is disabled when it is given no threshold', async () => {
    let calls = 0
    const { client: access } = client({
      error: new Error('the connection is refused'),
      breaker: { failures: 0, cooldownMs: 60_000 },
      onRequest: () => {
        calls += 1
      },
    })
    await access.decide(request)
    await access.decide(request)
    expect(calls).toBe(2)
  })

  test('the service is tried again after the cooldown', async () => {
    let calls = 0
    let fail = true
    const access = new AccessClient({
      baseUrl: 'http://access.test',
      transport: {
        async post() {
          calls += 1
          if (fail) throw new Error('the connection is refused')
          return { status: 200, body: '{"allow":true}' }
        },
      },
      cache: new MemoryDecisionCache(),
      cacheTtlMs: 0,
      breaker: { failures: 1, cooldownMs: 0 },
    })
    await access.decide(request)
    // The cooldown is over: the service is tried again.
    fail = false
    const decision = await access.decide(request)
    expect(calls).toBe(2)
    expect(decision.allow).toBe(true)
  })
})
