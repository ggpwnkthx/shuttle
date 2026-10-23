import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, METRICS_TOKEN, type Harness } from './harness'

/**
 * The limits of a deployment whose shared state is not reachable.
 *
 * The limiter of a scope that lives in the shared state has no window to
 * count the request in while the server is down. The deployment decides
 * what happens then:
 *
 * - `local`: the request is counted in the window of the process, so the
 *   flood is bounded by the number of the replicas instead of being
 *   unbounded;
 * - `open`: every request is allowed — the behaviour of the releases
 *   before this one;
 * - `closed`: every request is refused.
 *
 * The degradation is visible: it is counted in the metrics and it is
 * written in the log.
 */

/** A Redis server that is not there. */
const DEAD_REDIS = 'redis://127.0.0.1:1/0'

/** The metrics of the gateway. */
async function metrics(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.gatewayUrl}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  return await response.text()
}

/** The times a budget was counted in the process. */
function fallbackCount(text: string): number {
  const match = /shuttle_rate_limit_fallback_total\{scope="route"\} (\d+)/.exec(text)
  return match ? Number(match[1]) : 0
}

describe('the limits while the shared state is down', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        // The state of the limits lives in a server that is not there.
        SHUTTLE_SHARED_STATE_URL: DEAD_REDIS,
        SHUTTLE_RATE_LIMIT_MAX: '2',
        SHUTTLE_RATE_LIMIT_WINDOW_MS: '60000',
        SHUTTLE_RATE_LIMIT_TOTAL_MAX: '0',
        SHUTTLE_LOG_LEVEL: 'warn',
      },
      routes: (context) => [
        {
          id: 'signed-site',
          match: { host: 'signed.shuttle.test', path: '/' },
          upstream: context.upstreamA,
          auth: { mode: 'none' },
        },
      ],
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the budget of the route is still enforced in the process', async () => {
    const call = (): Promise<Response> =>
      fetch(`${harness.gatewayUrl}/`, { headers: { host: 'signed.shuttle.test' } })

    // The shared state is not reachable, so the request is counted in the
    // window of the process: the budget of the deployment is still a
    // budget.
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const refused = await call()
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
  })

  test('the degradation is counted', async () => {
    const before = fallbackCount(await metrics(harness))
    await fetch(`${harness.gatewayUrl}/`, { headers: { host: 'signed.shuttle.test' } })
    expect(fallbackCount(await metrics(harness))).toBe(before + 1)
  })
})

describe('the limits while the shared state is down and the deployment accepts it', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        SHUTTLE_SHARED_STATE_URL: DEAD_REDIS,
        SHUTTLE_RATE_LIMIT_MAX: '1',
        SHUTTLE_RATE_LIMIT_WINDOW_MS: '60000',
        SHUTTLE_RATE_LIMIT_TOTAL_MAX: '0',
        // The deployment accepts the loss of the protection against a
        // flood while the shared state is down.
        SHUTTLE_RATE_LIMIT_FALLBACK: 'open',
      },
      routes: (context) => [
        {
          id: 'signed-site',
          match: { host: 'signed.shuttle.test', path: '/' },
          upstream: context.upstreamA,
          auth: { mode: 'none' },
        },
      ],
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('every request is allowed, as the earlier releases did', async () => {
    const call = (): Promise<Response> =>
      fetch(`${harness.gatewayUrl}/`, { headers: { host: 'signed.shuttle.test' } })
    for (let index = 0; index < 5; index++) {
      expect((await call()).status).toBe(200)
    }
  })
})
