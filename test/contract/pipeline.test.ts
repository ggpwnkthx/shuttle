import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { WORKSPACE_ID, createHarness, type Harness } from './harness'

/**
 * The order of the pipeline of the gateway.
 *
 * The order is part of the contract of the gateway: a request that is
 * refused by an earlier step never reaches a later one, and the budget of a
 * route is spent by the requests that the route would handle.
 *
 * The groups that speak the default configuration share one gateway.
 */
let defaultHarness: Harness

beforeAll(async () => {
  defaultHarness = await createHarness()
})

afterAll(async () => {
  await defaultHarness.stop()
})

describe('the pipeline of a request', () => {
  let harness: Harness

  // Every test starts with a full budget: a test that spent the budget of
  // another one would pass or fail with the order of the tests.
  beforeEach(async () => {
    harness = await createHarness({
      rateLimitMax: 2,
      rateLimitGlobalMax: 0,
    })
  })

  afterEach(async () => {
    await harness.stop()
  })

  test('a request that matches no route is refused', async () => {
    const response = await fetch(`${harness.gatewayUrl}/nothing-here`, {
      headers: { host: 'unknown.shuttle.test' },
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('no_route')
  })

  test('the limit of a route is spent by the requests of that route', async () => {
    const first = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(first.status).toBe(200)
    const second = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(second.status).toBe(200)
    const third = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(third.status).toBe(429)
    const body = (await third.json()) as { error: string }
    expect(body.error).toBe('too_many_requests')
    expect(third.headers.get('retry-after')).toBeTruthy()

    // Another route has its own budget.
    const other = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(other.status).toBe(401)
  })

  test('a request that is refused by the limiter never reaches the upstream', async () => {
    // The budget of the route is two requests.
    for (let spent = 0; spent < 2; spent++) {
      await fetch(`${harness.gatewayUrl}/`, { headers: { host: 'public.shuttle.test' } })
    }
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(429)
    const body = (await response.json()) as { service?: string }
    expect(body.service).toBeUndefined()
  })
})

describe('a gateway without a configuration', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      expectInvalidConfig: true,
      config: () => ({ version: 2 }),
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the dispatcher refuses the requests', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('not_ready')
  })

  test('the health is still available', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`)
    expect(response.status).toBe(200)
  })

  test('the readiness reports that the gateway is not ready', async () => {
    const response = await fetch(`${harness.gatewayUrl}/readyz`)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; config: { lastError: unknown } }
    expect(body.status).toBe('not-ready')
    expect(body.config.lastError).not.toBeNull()
  })
})

describe('the credentials of a request', () => {
  test('a bearer token that is invalid is not replaced by the session of the browser', async () => {
    const login = await defaultHarness.login()
    const response = await fetch(`${defaultHarness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: {
        host: 'api.shuttle.test',
        authorization: 'Bearer not-a-token',
        cookie: login.cookie,
      },
    })
    // The credential that the mode selected is invalid: the request is
    // refused, it does not fall back to the cookie of the browser.
    expect(response.status).toBe(401)
  })

  test('a header that is not a bearer token is refused', async () => {
    const response = await fetch(`${defaultHarness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(response.status).toBe(401)
  })

  test('the session of the browser authenticates the caller', async () => {
    const login = await defaultHarness.login()
    const response = await fetch(`${defaultHarness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBe('user-alice')
  })

  test('the cookie of the session is refreshed, also when the request is refused', async () => {
    const login = await defaultHarness.login()
    // The workspace of the caller is not one it may use: the request is
    // refused, and the browser still learns about the new lifetime of the
    // session.
    const response = await fetch(
      `${defaultHarness.gatewayUrl}/ws/22222222-2222-4222-8222-222222222222/`,
      {
        headers: { host: 'api.shuttle.test', cookie: login.cookie },
      }
    )
    expect(response.status).toBe(403)
    const cookies = response.headers.getSetCookie()
    const refreshed = cookies.find((cookie) => cookie.startsWith('shuttle_session='))
    expect(refreshed).toBeTruthy()
    expect(refreshed).toContain('Max-Age=')
    expect(refreshed).toContain('HttpOnly')
    expect(refreshed).toContain('SameSite=Lax')
    expect(refreshed).toContain('Path=/')
  })
})

describe('the cross site guard', () => {
  test('the gateway refuses a request from another site that changes the state', async () => {
    const login = await defaultHarness.login()
    const response = await fetch(`${defaultHarness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('cross_site_request')
  })

  test('a request without the cookie of the session is not guarded', async () => {
    const response = await fetch(`${defaultHarness.gatewayUrl}/`, {
      method: 'POST',
      headers: {
        host: 'public.shuttle.test',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(200)
  })

  test('the gateway refuses a logout from another site', async () => {
    const login = await defaultHarness.login()
    const response = await fetch(`${defaultHarness.gatewayUrl}/auth/logout`, {
      redirect: 'manual',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(403)
  })
})
