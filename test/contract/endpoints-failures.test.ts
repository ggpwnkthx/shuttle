import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemorySessionStore } from '../../src/domains/authentication/adapters'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The store of the sessions of the process and the refusals of the
 * endpoints of the gateway.
 *
 * The endpoints of the gateway answer the callers that arrive while the
 * identity provider or the session store is not reachable: the answers have
 * to say what happened, and they have to be the documented ones.
 */
describe('the store of the sessions of the process', () => {
  test('the store reports its lifetime', () => {
    const store = new MemorySessionStore({ ttlMs: 1000, maxAgeMs: 2000, touchIntervalMs: 100 })
    expect(store.ttlMs).toBe(1000)
    expect(store.maxAgeMs).toBe(2000)
    expect(store.touchIntervalMs).toBe(100)
  })

  test('the store forgets every session when it is closed', async () => {
    const store = new MemorySessionStore({ ttlMs: 60_000, maxAgeMs: 0, touchIntervalMs: 1000 })
    const created = await store.create({ subject: 'user-1' })
    expect(store.size).toBe(1)
    await store.close()
    expect(store.size).toBe(0)
    expect(await store.get(created.id)).toBeNull()
  })

  test('the store reports the lifetime of the cookie of a session', async () => {
    const store = new MemorySessionStore({ ttlMs: 60_000, maxAgeMs: 0, touchIntervalMs: 1000 })
    const created = await store.create({ subject: 'user-1' })
    expect(store.cookieMaxAgeSeconds(created.id)).toBeGreaterThan(0)
    expect(store.cookieMaxAgeSeconds('unknown')).toBe(0)
  })

  test('the store answers the probe of the readiness', async () => {
    const store = new MemorySessionStore()
    expect(await store.ping()).toBe(true)
  })
})

describe('the refusals of the endpoints of the gateway', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ loginRateLimitMax: 1 })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the logins of a caller are limited', async () => {
    const first = await fetch(`${harness.gatewayUrl}/auth/login?redirect=%2F`, {
      redirect: 'manual',
    })
    expect(first.status).toBe(302)

    const second = await fetch(`${harness.gatewayUrl}/auth/login?redirect=%2F`, {
      redirect: 'manual',
    })
    expect(second.status).toBe(429)
    const body = (await second.json()) as { error: string }
    expect(body.error).toBe('too_many_requests')
    expect(second.headers.get('retry-after')).toBeTruthy()
  })
})

describe('a gateway whose identity provider is not reachable', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: { SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1' },
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the login answers that the provider is not reachable', async () => {
    const response = await fetch(`${harness.gatewayUrl}/auth/login?redirect=%2F`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('identity_provider_unavailable')
  })
})

describe('a gateway whose session store is not reachable', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: { SHUTTLE_SESSION_URL: 'redis://127.0.0.1:1/0' },
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the readiness reports that the store is not reachable', async () => {
    const response = await fetch(`${harness.gatewayUrl}/readyz`)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; sessionStore: string }
    expect(body.sessionStore).toBe('unavailable')
  })

  test('a request that needs a session is refused', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: {
        host: 'api.shuttle.test',
        cookie: 'shuttle_session=the-id-of-a-caller',
      },
    })
    // The store cannot be reached: the gateway fails closed.
    expect(response.status).toBe(401)
  })
})
