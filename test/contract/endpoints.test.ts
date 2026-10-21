import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { METRICS_TOKEN, WORKSPACE_ID, createHarness, type Harness } from './harness'

/**
 * The endpoints of the gateway.
 *
 * The endpoints are the paths the gateway serves itself: they are matched
 * before the route table and they are never forwarded to an upstream.
 *
 * The three groups below share one gateway: they speak the same routes and
 * they do not change the state of each other.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

describe('the endpoints of the gateway', () => {
  test('the health is always available', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; service: string }
    expect(body.status).toBe('ok')
    expect(body.service).toBe('shuttle')
  })

  test('the readiness reports the configuration and the session store', async () => {
    const response = await fetch(`${harness.gatewayUrl}/readyz`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      config: { loaded: boolean; lastError: unknown }
      sessionStore: string
    }
    expect(body.status).toBe('ready')
    expect(body.config.loaded).toBe(true)
    expect(body.config.lastError).toBeNull()
    expect(body.sessionStore).toBe('ok')
  })

  test('the metrics need a token', async () => {
    const withoutToken = await fetch(`${harness.gatewayUrl}/metrics`)
    expect(withoutToken.status).toBe(401)

    const withAWrongToken = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(withAWrongToken.status).toBe(401)

    const withTheToken = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
    expect(withTheToken.status).toBe(200)
    const body = await withTheToken.text()
    expect(body).toContain('shuttle_requests_total')
  })

  test('a path of the gateway with another method is refused', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`, { method: 'POST' })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  test('every answer carries the identifier of the request', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`, {
      headers: { 'x-request-id': 'my-request-1' },
    })
    expect(response.headers.get('x-request-id')).toBe('my-request-1')
  })

  test('an identifier that is not valid is replaced', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`, {
      headers: { 'x-request-id': 'not valid!' },
    })
    const id = response.headers.get('x-request-id')
    expect(id).toBeTruthy()
    expect(id).not.toBe('not valid!')
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  })

  test('an identifier that is too long is replaced', async () => {
    const response = await fetch(`${harness.gatewayUrl}/healthz`, {
      headers: { 'x-request-id': 'a'.repeat(65) },
    })
    expect(response.headers.get('x-request-id')).not.toBe('a'.repeat(65))
  })
})

describe('the reserved paths', () => {
  // This group needs its own gateway: its route table matches every host.
  let catchAll: Harness

  beforeAll(async () => {
    catchAll = await createHarness({
      config: (context) => ({
        version: 1,
        routes: [
          {
            id: 'catch-all',
            match: { host: '*', path: '/' },
            upstream: context.upstreamA,
            auth: { mode: 'none' },
          },
        ],
      }),
    })
  })

  afterAll(async () => {
    await catchAll.stop()
  })

  test('a route cannot shadow the paths of the gateway', async () => {
    const response = await fetch(`${catchAll.gatewayUrl}/metrics`)
    // The answer comes from the gateway, not from the upstream: the route
    // that matches every host does not own the paths of the gateway.
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: string; service?: string }
    expect(body.error).toBe('unauthorized')
    expect(body.service).toBeUndefined()
  })
})

describe('the answer of an upstream', () => {
  test('the location of the upstream is rewritten before it reaches the browser', async () => {
    const response = await fetch(
      `${harness.gatewayUrl}/redirect?to=${encodeURIComponent(`${harness.upstreamA.url}/login`)}`,
      {
        headers: { host: 'public.shuttle.test' },
        redirect: 'manual',
      }
    )
    expect(response.status).toBe(302)
    // The internal hostname of the upstream never reaches the browser.
    expect(response.headers.get('location')).toBe('/login')
  })

  test('a location that names another host is left alone for the browser', async () => {
    const response = await fetch(
      `${harness.gatewayUrl}/redirect?to=${encodeURIComponent('https://accounts.example.com/login')}`,
      {
        headers: { host: 'public.shuttle.test' },
        redirect: 'manual',
      }
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://accounts.example.com/login')
  })
})

describe('the workspace of a request', () => {
  test('a request without a credential is refused', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(401)
  })

  test('a workspace identifier that is not a uuid is a bad request', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/not-a-uuid/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('bad_request')
  })

  test('a caller that may not use the workspace is refused', async () => {
    const token = await harness.token({ subject: 'user-bob' })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('workspace_forbidden')
  })

  test('a caller that may use the workspace reaches the upstream', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBe('user-alice')
    expect(body.headers['x-shuttle-workspace']).toBe(WORKSPACE_ID)
  })
})
