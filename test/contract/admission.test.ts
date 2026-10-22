import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The admission of the requests.
 *
 * The cap of the exchanges bounds the requests that are talking to an
 * upstream at the same time. The admission bounds the requests that are
 * **inside the gateway**, and it covers the phase that comes before the
 * exchange: the limits, the session and the decision of the access
 * service.
 *
 * The gap it closes: a request that waits for a dependency that does not
 * answer never reaches the exchange, so the cap of the exchanges never
 * sees it. The number of requests that wait at the same time was bounded
 * by the number of sockets and by the memory of the process.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    // One request at a time may be inside the gateway.
    env: { SHUTTLE_MAX_PENDING_REQUESTS: '1' },
    routes: (context) => [
      {
        id: 'slow',
        match: { host: 'api.shuttle.test', path: '/slow/' },
        // The upstream accepts the connection and never answers: the
        // request stays inside the gateway.
        upstream: context.hung,
        auth: { mode: 'none' },
        timeouts: { responseMs: 1_500 },
      },
      {
        id: 'quick',
        match: { host: 'api.shuttle.test', path: '/quick/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the admission of the requests', () => {
  test('a request that does not fit is refused at once', async () => {
    // The first request waits for an upstream that never answers: it
    // holds the slot of the admission.
    const first = fetch(`${harness.gatewayUrl}/slow/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    // The second request does not fit. It is refused at once: a refusal
    // is faster than a wait.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    const second = await fetch(`${harness.gatewayUrl}/quick/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(second.status).toBe(503)
    const body = (await second.json()) as { error: string }
    expect(body.error).toBe('gateway_overloaded')
    expect(Date.now() - started).toBeLessThan(500)
    // The first request is still waiting for its upstream.
    const firstResponse = await first
    expect(firstResponse.status).toBe(504)
  })

  test('a request is admitted again when the slot is free', async () => {
    const response = await fetch(`${harness.gatewayUrl}/quick/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
  })
})
