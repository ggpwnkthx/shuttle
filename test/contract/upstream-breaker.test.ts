import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The health of the upstreams.
 *
 * A request that changes the state of an upstream is never sent to two of
 * them, so the failover of a route does not reach the second upstream when
 * the first one is down: the request is refused and the operator sees a
 * gateway that does not fail over at all.
 *
 * The breaker closes that gap without sending a request twice: an upstream
 * that failed recently is moved to the end of the list, so the next request
 * of the route goes to an upstream that answered recently.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    env: {
      // One failure is enough to skip an upstream, so the test does not
      // have to warm the breaker up.
      SHUTTLE_UPSTREAM_BREAKER_FAILURES: '1',
      SHUTTLE_UPSTREAM_BREAKER_COOLDOWN_MS: '60000',
    },
    routes: (context) => [
      {
        id: 'mutating',
        match: { host: 'api.shuttle.test', path: '/mutating/' },
        // The first upstream is not there: the connection is refused.
        upstream: ['http://127.0.0.1:1/', context.upstreamB],
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the health of the upstreams', () => {
  test('a request that changes the state of an upstream is refused when it is down', async () => {
    const response = await fetch(`${harness.gatewayUrl}/mutating/asset`, {
      method: 'POST',
      headers: { host: 'api.shuttle.test' },
      body: JSON.stringify({ hello: 'world' }),
    })
    // The request is not sent twice: it is refused, the way it was before
    // the breaker existed.
    expect(response.status).toBe(502)
  })

  test('the next request of the route goes to the upstream that answered', async () => {
    const response = await fetch(`${harness.gatewayUrl}/mutating/asset`, {
      method: 'POST',
      headers: { host: 'api.shuttle.test' },
      body: JSON.stringify({ hello: 'world' }),
    })
    // The first upstream failed and was skipped: the request went to the
    // second one, and it was sent once.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-b')
  })

  test('the failures of the upstreams are published', async () => {
    const response = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: 'Bearer test-metrics-token' },
    })
    const body = await response.text()
    expect(body).toContain('shuttle_upstream_failures_total')
    expect(body).toContain('shuttle_upstreams_skipped_total')
  })
})
