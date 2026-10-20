import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The trust boundary between the gateway and its upstreams.
 *
 * An upstream is a different trust domain: it sees the requests of the
 * callers and it answers to them. The gateway must not hand it a
 * credential of the caller, and it must not let it put an identity into
 * the answer of the gateway.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    trustedProxies: [],
    routes: () => [
      {
        id: 'public-site',
        match: { host: 'public.shuttle.test', path: '/' },
        upstream: 'http://127.0.0.1:9',
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the credentials of the caller', () => {
  test('the session cookie of the gateway never reaches an upstream', async () => {
    // An upstream that receives the session id of the caller can act as
    // the caller against the gateway itself, and against every other route
    // of it. The cookie is a credential of the gateway, so it stays in the
    // gateway.
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({ cookie: req.headers.get('cookie') })
      },
    })
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: `http://127.0.0.1:${upstream.port}`,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const login = await local.login()
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: {
          host: 'public.shuttle.test',
          cookie: `${login.cookie}; app_session=abc`,
        },
      })
      const body = (await response.json()) as { cookie: string | null }
      // The cookie of the gateway is not in the request of the upstream.
      expect(body.cookie ?? '').not.toContain('shuttle_session')
      // The cookies of the application are kept: they belong to it.
      expect(body.cookie ?? '').toContain('app_session=abc')
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test('an upstream cannot plant a session cookie in the browser', async () => {
    // A `Set-Cookie` of the upstream that names the cookie of the gateway
    // would fix the session of the browser to an id of the choice of the
    // upstream, or log the browser out. The name belongs to the gateway.
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok', {
          headers: {
            'set-cookie': 'shuttle_session=ATTACKER_CHOSEN; Path=/',
          },
        })
      },
    })
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: `http://127.0.0.1:${upstream.port}`,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      const cookies = response.headers.getSetCookie()
      expect(cookies.some((c) => c.startsWith('shuttle_session='))).toBe(false)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test('the cookies of the application are forwarded', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({ cookie: req.headers.get('cookie') })
      },
    })
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: `http://127.0.0.1:${upstream.port}`,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test', cookie: 'app_session=abc; theme=dark' },
      })
      const body = (await response.json()) as { cookie: string | null }
      expect(body.cookie).toContain('app_session=abc')
      expect(body.cookie).toContain('theme=dark')
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })
})

describe('the headers of the answer of an upstream', () => {
  test('an upstream cannot put an identity into the answer', async () => {
    // The identity headers are the ones the gateway writes on a request.
    // An upstream that answered with them would put an identity into the
    // response, where a browser or a client library could read it and
    // believe it.
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok', {
          headers: {
            'x-shuttle-user': 'admin',
            'x-shuttle-roles': 'admin',
            'x-shuttle-signature': 'v3=deadbeef',
            'x-forwarded-for': '203.0.113.7',
            'x-real-ip': '203.0.113.7',
          },
        })
      },
    })
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: `http://127.0.0.1:${upstream.port}`,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      expect(response.headers.get('x-shuttle-user')).toBeNull()
      expect(response.headers.get('x-shuttle-roles')).toBeNull()
      expect(response.headers.get('x-shuttle-signature')).toBeNull()
      expect(response.headers.get('x-forwarded-for')).toBeNull()
      expect(response.headers.get('x-real-ip')).toBeNull()
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test('the cookies of the application are forwarded in the answer', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok', {
          headers: { 'set-cookie': 'app_session=abc; Path=/; HttpOnly' },
        })
      },
    })
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: `http://127.0.0.1:${upstream.port}`,
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      expect(response.headers.getSetCookie().some((c) => c.startsWith('app_session='))).toBe(true)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })
})

describe('the message of a failure', () => {
  test('a network failure does not name the internal host of the upstream', async () => {
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          // A port that nothing listens on: the connection is refused.
          upstream: 'http://127.0.0.1:9/internal-name',
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const response = await fetch(`${local.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      expect(response.status).toBe(502)
      const body = (await response.json()) as { message: string }
      // The message names no internal host and no internal port.
      expect(body.message).not.toContain('internal-name')
      expect(body.message).not.toContain('127.0.0.1')
      expect(body.message).not.toContain('ECONNREFUSED')
    } finally {
      await local.stop()
    }
  })
})

describe('the address of the caller', () => {
  test('a client cannot choose the address the gateway attributes to it', async () => {
    // A client behind a trusted proxy can send its own `x-forwarded-for`
    // header. It can only add entries on the left of the chain, so the
    // address the gateway uses is the right-most entry that is not a
    // trusted proxy. Without that, the client would choose the key of the
    // rate limiter and escape it.
    const local = await createHarness({
      trustedProxies: ['127.0.0.1/32'],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: 'http://127.0.0.1:9',
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const seen: string[] = []
      const upstream = Bun.serve({
        port: 0,
        fetch(req) {
          seen.push(req.headers.get('x-real-ip') ?? '')
          return new Response('ok')
        },
      })
      const withUpstream = await createHarness({
        trustedProxies: ['127.0.0.1/32'],
        routes: () => [
          {
            id: 'public-site',
            match: { host: 'public.shuttle.test', path: '/' },
            upstream: `http://127.0.0.1:${upstream.port}`,
            auth: { mode: 'none' },
          },
        ],
      })
      try {
        await withUpstream.gatewayUrl &&
          (await fetch(`${withUpstream.gatewayUrl}/`, {
            headers: {
              host: 'public.shuttle.test',
              'x-forwarded-for': '9.9.9.9, 198.51.100.9',
            },
          }))
        // The address of the client is the one the proxy added, not the one
        // the client injected.
        expect(seen[0]).toBe('198.51.100.9')
      } finally {
        await withUpstream.stop()
        upstream.stop(true)
      }
    } finally {
      await local.stop()
    }
  })
})

describe('the request of a browser', () => {
  test('a sibling subdomain cannot change the state of an upstream', async () => {
    // `Sec-Fetch-Site: same-site` means the same registrable domain, not
    // the same origin. A sibling subdomain is a different origin, and it
    // must not be able to make a request with the cookie of the caller.
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'workspace-api',
          match: { host: 'api.shuttle.test', path: `/ws/${WORKSPACE_ID}/` },
          upstream: 'http://127.0.0.1:9',
          auth: { mode: 'any' },
        },
      ],
    })
    try {
      const login = await local.login()
      const response = await fetch(`${local.gatewayUrl}/ws/${WORKSPACE_ID}/echo`, {
        method: 'POST',
        headers: {
          host: 'api.shuttle.test',
          cookie: login.cookie,
          origin: 'https://attacker.shuttle.test',
          'sec-fetch-site': 'same-site',
        },
      })
      expect(response.status).toBe(403)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe('cross_site_request')
    } finally {
      await local.stop()
    }
  })
})

describe('the target of a login', () => {
  test('a control character in the target is refused', async () => {
    // Browsers strip the tabs and the newlines of a url before they
    // resolve it, so a target that carries one would leave the site.
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: 'http://127.0.0.1:9',
          auth: { mode: 'none' },
        },
      ],
    })
    try {
      const jar = new (await import('./helpers/harness')).CookieJar()
      const res = await fetch(
        `${local.gatewayUrl}/auth/login?redirect=${encodeURIComponent('/\t/evil.com')}`,
        { redirect: 'manual' }
      )
      jar.capture(res)
      const callback = await local.signInAtProvider(res.headers.get('location')!, {})
      const cbRes = await fetch(callback, { headers: { cookie: jar.header() }, redirect: 'manual' })
      const location = cbRes.headers.get('location')
      // The target stays on the site of the gateway.
      expect(location?.startsWith('//')).toBe(false)
      expect(location).not.toContain('\t')
      expect(location).not.toContain('evil.com')
    } finally {
      await local.stop()
    }
  })
})
