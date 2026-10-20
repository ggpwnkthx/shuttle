import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The cross site guard.
 *
 * A caller that authenticates with a session cookie is a browser, and a
 * browser can be made to send a request to the gateway from another site.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    allowedOrigins: ['https://app.example.com'],
  })
})

afterAll(async () => {
  await harness.stop()
})

function url(path: string): string {
  return `${harness.gatewayUrl}${path}`
}

describe('the cross site guard', () => {
  test('refuses a request that changes the state of an upstream', async () => {
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('cross_site_request')
  })

  test('refuses a request from another origin without the fetch site header', async () => {
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(403)
  })

  test('allows a navigation from another site', async () => {
    // A link in an e-mail points at the application from another site.
    // Refusing it would break every deep link, so a navigation is allowed
    // unless the strict mode is on.
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/`), {
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(200)
  })

  test('allows an origin that is allowed explicitly', async () => {
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
  })

  test('allows a request of the site itself', async () => {
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'same-origin',
        origin: `http://localhost:${new URL(harness.gatewayUrl).port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
  })

  test('allows a request that comes from a client that is not a browser', async () => {
    // A service to service call has neither the fetch site nor the origin
    // header, and it is not a cross site request.
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
  })

  test('does not touch a caller that authenticated with a token', async () => {
    // A bearer token is not sent by a browser, so there is nothing to steal.
    const token = await harness.token()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        authorization: `Bearer ${token}`,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
  })

  test('refuses a cross site request to a route without a policy', async () => {
    // The route has no policy of its own, but the browser still sends the
    // session cookie, so the request is a request of a browser and it
    // changes the state of an upstream.
    const login = await harness.login()
    const response = await fetch(url('/echo'), {
      method: 'POST',
      headers: {
        host: 'public.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('cross_site_request')
  })

  test('uses the protocol the trusted proxy reports', async () => {
    // The gateway is behind a proxy that terminates TLS: the browser uses
    // https, the proxy reports it, and the origin of the request is the one
    // of the site itself.
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
        origin: 'https://api.shuttle.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
  })

  test('ignores a protocol a trusted proxy reports wrongly', async () => {
    // Only http and https are protocols a browser can use. A header that
    // names another one is ignored, so the origin of the request is the one
    // of the site itself (http) and a request of another origin is refused.
    const login = await harness.login()
    const response = await fetch(url(`/ws/${WORKSPACE_ID}/echo`), {
      method: 'POST',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'x-forwarded-proto': 'javascript',
        'sec-fetch-site': 'cross-site',
        origin: 'https://api.shuttle.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(403)
  })
})

describe('the cross site guard in the strict mode', () => {
  let strict: Harness

  beforeAll(async () => {
    strict = await createHarness({ csrfStrict: true })
  })

  afterAll(async () => {
    await strict.stop()
  })

  test('refuses a navigation from another site as well', async () => {
    const login = await strict.login()
    const response = await fetch(`${strict.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(403)
  })

  test('still allows the request of the site itself', async () => {
    const login = await strict.login()
    const response = await fetch(`${strict.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'same-site',
      },
    })
    expect(response.status).toBe(200)
  })
})
