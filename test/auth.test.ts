import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, OTHER_WORKSPACE_ID, WORKSPACE_ID, type Harness } from './helpers/harness'

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
      {
        id: 'open-api',
        match: { host: 'open.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'any' },
      },
      {
        id: 'session-only',
        match: { host: 'session.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'session' },
      },
      {
        id: 'jwt-only',
        match: { host: 'jwt.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'jwt' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('browser authentication', () => {
  test('the login flow creates a session that authorises requests', async () => {
    const login = await harness.login()
    expect(login.sessionCookie).toStartWith('shuttle_session=')

    const response = await fetch(
      `${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`,
      { headers: { host: 'api.shuttle.test', cookie: login.cookie } }
    )
    expect(response.status).toBe(200)
  })

  test('a request without credentials is rejected', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  test('a browser request without credentials is redirected to the login page', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', accept: 'text/html' },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toStartWith('/auth/login?redirect=')
  })

  test('the redirect uri of the exchange is the configured one', async () => {
    // The gateway may be reached under another name than the identity
    // provider knows: the exchange must use the configured redirect uri.
    const login = await harness.login()
    expect(login.callbackUrl).toBeDefined()
    expect(login.callbackUrl!.startsWith(harness.gatewayUrl)).toBe(true)
  })

  test('the state cookie is single use', async () => {
    const login = await harness.login()
    expect(login.callbackUrl).toBeDefined()

    // The very same callback cannot be replayed: the login state was consumed.
    const replay = await fetch(login.callbackUrl!, {
      redirect: 'manual',
      headers: { cookie: login.jar!.header() },
    })
    expect(replay.status).toBe(400)
  })

  test('a callback without the login state cookie is rejected', async () => {
    const start = await fetch(`${harness.gatewayUrl}/auth/login?start=provider&redirect=%2F`, {
      redirect: 'manual',
    })
    const authorizeUrl = start.headers.get('location')!
    const callbackUrl = await harness.signInAtProvider(authorizeUrl)
    const callback = await fetch(callbackUrl, { redirect: 'manual' })
    expect(callback.status).toBe(400)
  })
})

describe('bearer tokens', () => {
  test('a valid token authorises the request', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
  })

  test('a malformed token is rejected', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', authorization: 'Bearer not-a-token' },
    })
    expect(response.status).toBe(401)
  })

  test('a non bearer authorization header is rejected', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(response.status).toBe(401)
  })
})

describe('roles', () => {
  test('the gateway does not check roles itself', async () => {
    // The access service owns the decision, the gateway only forwards the
    // roles of the caller.
    const token = await harness.token({ subject: 'user-bob', email: 'bob@shuttle.test' })
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'open.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
  })

  test('a role based denial of the access service is counted separately', async () => {
    const roleHarness = await createHarness({
      policy: {
        'user-alice': {
          workspaces: [],
          reason: 'the subject is missing the admin role',
        },
      },
    })
    try {
      const login = await roleHarness.login()
      const response = await fetch(
        `${roleHarness.gatewayUrl}/ws/${WORKSPACE_ID}/data`,
        { headers: { host: 'api.shuttle.test', cookie: login.cookie } }
      )
      expect(response.status).toBe(403)

      const metrics = await fetch(`${roleHarness.gatewayUrl}/metrics`, {
        headers: { authorization: `Bearer ${roleHarness.metricsToken}` },
      })
      const body = await metrics.text()
      expect(body).toContain('shuttle_auth_failures_total{route="workspace-api",reason="missing_role"} 1')
    } finally {
      await roleHarness.stop()
    }
  })
})

describe('credential selection', () => {
  test('a session route only accepts the session cookie', async () => {
    const token = await harness.token()
    const withToken = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'session.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(withToken.status).toBe(401)

    const login = await harness.login()
    const withCookie = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'session.shuttle.test', cookie: login.cookie },
    })
    expect(withCookie.status).toBe(200)
  })

  test('a bearer route only accepts the bearer token', async () => {
    const login = await harness.login()
    const withCookie = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'jwt.shuttle.test', cookie: login.cookie },
    })
    expect(withCookie.status).toBe(401)

    const token = await harness.token()
    const withToken = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'jwt.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(withToken.status).toBe(200)
  })

  test('an invalid token is not replaced by the session', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'open.shuttle.test',
        cookie: login.cookie,
        authorization: 'Bearer not-a-token',
      },
    })
    expect(response.status).toBe(401)
  })
})

describe('workspace access', () => {
  test('a workspace the user does not belong to is denied', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/ws/${OTHER_WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('workspace_forbidden')
  })

  test('an invalid workspace identifier is rejected', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/ws/not-a-uuid/data`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(400)
  })

  test('an unavailable access service denies the request', async () => {
    const broken = await createHarness({ accessUnavailable: true })
    try {
      const login = await broken.login()
      const response = await fetch(`${broken.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
        headers: { host: 'api.shuttle.test', cookie: login.cookie },
      })
      expect(response.status).toBe(403)
    } finally {
      await broken.stop()
    }
  })
})

describe('the default policy of the routes', () => {
  let defaults: Harness

  beforeAll(async () => {
    defaults = await createHarness({
      config: () => ({
        version: 1,
        defaults: { auth: { mode: 'session' } },
        routes: [],
      }),
      routes: ({ upstreamA }) => [
        {
          id: 'inherits-the-default',
          match: { host: 'default.shuttle.test', path: '/' },
          upstream: upstreamA,
        },
        {
          id: 'has-its-own-policy',
          match: { host: 'explicit.shuttle.test', path: '/' },
          upstream: upstreamA,
          auth: { mode: 'none' },
        },
      ],
    })
  })

  afterAll(async () => {
    await defaults.stop()
  })

  test('a route without a policy requires the credentials of the default policy', async () => {
    const response = await fetch(`${defaults.gatewayUrl}/`, {
      headers: { host: 'default.shuttle.test' },
    })
    expect(response.status).toBe(401)
  })

  test('a session of the caller authorises the request', async () => {
    const login = await defaults.login()
    const response = await fetch(`${defaults.gatewayUrl}/`, {
      headers: { host: 'default.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(200)
  })

  test('a route with its own policy is not affected by the default', async () => {
    const response = await fetch(`${defaults.gatewayUrl}/`, {
      headers: { host: 'explicit.shuttle.test' },
    })
    expect(response.status).toBe(200)
  })
})
