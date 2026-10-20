import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    trustedProxies: [],
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
        maxBodyBytes: 64 * 1024,
      },
      {
        id: 'broken-upstream',
        match: { host: 'broken.shuttle.test', path: '/' },
        upstream: 'http://127.0.0.1:9',
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('http proxying', () => {
  test('preserves the method, the path and the query string', async () => {
    const response = await fetch(
      `${harness.gatewayUrl}/some/path?alpha=1&beta=two`,
      { headers: { host: 'public.shuttle.test' } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      method: string
      path: string
      query: Record<string, string>
    }
    expect(body.method).toBe('GET')
    expect(body.path).toBe('/some/path')
    expect(body.query).toEqual({ alpha: '1', beta: 'two' })
  })

  test('preserves the status code of the upstream', async () => {
    const response = await fetch(`${harness.gatewayUrl}/status/418`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(418)
  })

  test('does not follow upstream redirects', async () => {
    const response = await fetch(`${harness.gatewayUrl}/redirect?to=/elsewhere`, {
      headers: { host: 'public.shuttle.test' },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/elsewhere')
  })

  test('preserves cookies set by the upstream', async () => {
    const response = await fetch(`${harness.gatewayUrl}/set-cookie`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('upstream_session=abc123')
  })

  test('streams the request body to the upstream', async () => {
    const payload = 'x'.repeat(200_000)
    const response = await fetch(`${harness.gatewayUrl}/echo`, {
      method: 'POST',
      headers: { host: 'public.shuttle.test', 'content-type': 'text/plain' },
      body: payload,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { length: number }
    expect(body.length).toBe(payload.length)
  })

  test('rejects a body that is larger than the configured limit', async () => {
    const login = await harness.login()
    const payload = 'x'.repeat(200_000)
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/echo`, {
      method: 'POST',
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
      body: payload,
    })
    expect(response.status).toBe(413)
  })

  test('rejects a streamed body that exceeds the limit', async () => {
    const login = await harness.login()
    const chunk = new TextEncoder().encode('x'.repeat(16_384))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 16; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/echo`, {
      method: 'POST',
      headers: { host: 'api.shuttle.test', cookie: login.cookie, 'content-type': 'application/octet-stream' },
      body,
      // @ts-expect-error duplex is required for streaming bodies
      duplex: 'half',
    })
    expect(response.status).toBe(413)
  })

  test('aborts the upstream request when the client goes away', async () => {
    const controller = new AbortController()
    const pending = fetch(`${harness.gatewayUrl}/slow?ms=3000`, {
      headers: { host: 'public.shuttle.test' },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 150)
    let aborted = false
    try {
      await pending
    } catch {
      aborted = true
    }
    expect(aborted).toBe(true)
  })

  test('returns a bad gateway when the upstream is unreachable', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'broken.shuttle.test' },
    })
    expect(response.status).toBe(502)
  })

  test('returns not found when no route matches', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'unknown.shuttle.test' },
    })
    expect(response.status).toBe(404)
  })
})

describe('header handling', () => {
  test('strips spoofed identity headers', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'public.shuttle.test',
        'x-shuttle-user': 'attacker',
        'x-shuttle-email': 'attacker@example.com',
        'x-shuttle-roles': 'admin',
        'x-shuttle-workspace': '00000000-0000-0000-0000-000000000000',
        'x-forwarded-user': 'attacker',
      },
    })
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBeUndefined()
    expect(body.headers['x-shuttle-email']).toBeUndefined()
    expect(body.headers['x-shuttle-roles']).toBeUndefined()
    expect(body.headers['x-shuttle-workspace']).toBeUndefined()
  })

  test('does not trust forwarding headers from an untrusted peer', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'public.shuttle.test',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
      },
    })
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-forwarded-for']).not.toContain('203.0.113.7')
    expect(body.headers['x-forwarded-proto']).toBe('http')
    expect(body.headers['x-forwarded-host']).toBe('public.shuttle.test')
  })

  test('forwards the authenticated identity to the upstream', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBe('user-alice')
    expect(body.headers['x-shuttle-email']).toBe('alice@shuttle.test')
    expect(body.headers['x-shuttle-roles']).toContain('admin')
    expect(body.headers['x-shuttle-workspace']).toBe(WORKSPACE_ID)
  })

  test('trusts forwarding headers from a configured proxy', async () => {
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
          'x-forwarded-for': '203.0.113.7',
          'x-forwarded-proto': 'https',
        },
      })
      const body = (await response.json()) as { headers: Record<string, string> }
      expect(body.headers['x-forwarded-for']).toContain('203.0.113.7')
      expect(body.headers['x-forwarded-proto']).toBe('https')
    } finally {
      await trusted.stop()
    }
  })
})

describe('server sent events', () => {
  test('streams the event stream through the gateway', async () => {
    const response = await fetch(`${harness.gatewayUrl}/sse`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let received = ''
    while (received.split('event: message').length - 1 < 3) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    expect(received).toContain('event: message')
    expect(received).toContain('upstream-a')
  })

  test('a stream that keeps making progress is not cut off', async () => {
    // The body budget is an *idle* budget: it measures the time between
    // two events, not the total duration of the stream. A stream that
    // keeps sending is not cut off, even when it lives longer than the
    // budget.
    const local = await createHarness({
      trustedProxies: [],
      routes: () => [
        {
          id: 'slow-stream',
          match: { host: 'stream.shuttle.test', path: '/' },
          upstream: 'http://127.0.0.1:9',
          auth: { mode: 'none' },
        },
      ],
    })
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let index = 0; index < 8; index++) {
              await Bun.sleep(80)
              controller.enqueue(new TextEncoder().encode(`tick ${index}\n`))
            }
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const withUpstream = await createHarness({
        trustedProxies: [],
        routes: () => [
          {
            id: 'slow-stream',
            match: { host: 'stream.shuttle.test', path: '/' },
            upstream: `http://127.0.0.1:${upstream.port}`,
            auth: { mode: 'none' },
            // The budget is far shorter than the life of the stream, but
            // the stream never stays silent for that long.
            timeouts: { bodyMs: 300 },
          },
        ],
      })
      try {
        const response = await fetch(`${withUpstream.gatewayUrl}/`, {
          headers: { host: 'stream.shuttle.test' },
        })
        expect(response.status).toBe(200)
        const text = await response.text()
        // The whole stream arrived: it was never cut off.
        expect(text).toContain('tick 7')
        expect(text.split('tick').length - 1).toBe(8)
      } finally {
        await withUpstream.stop()
      }
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })
})

describe('the budgets of the upstream exchange', () => {
  let budgets: Harness

  beforeAll(async () => {
    budgets = await createHarness({
      routes: ({ upstreamA }) => [
        {
          id: 'slow-upstream',
          match: { host: 'slow.shuttle.test', path: '/slow' },
          upstream: upstreamA,
          auth: { mode: 'none' },
          timeouts: { connectMs: 200 },
        },
      ],
    })
  })

  afterAll(async () => {
    await budgets.stop()
  })

  test('gives up on an upstream that does not answer', async () => {
    const started = Date.now()
    const response = await fetch(`${budgets.gatewayUrl}/slow?ms=3000`, {
      headers: { host: 'slow.shuttle.test' },
    })
    const elapsed = Date.now() - started

    expect(response.status).toBe(504)
    // The connect budget fired, not the header budget of the configuration.
    expect(elapsed).toBeLessThan(2_000)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain('did not start answering')
  })
})
