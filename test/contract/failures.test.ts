import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The failures of an exchange.
 *
 * The table of the specification is normative: before the answer of the
 * upstream is sent, the gateway answers with its own status, and after it
 * is sent the body ends instead. The statuses are observed by the caller
 * and, for the caller that went away, by the metrics.
 */
describe('the failures of an exchange', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      // The budget of the answer is short: an upstream that does not answer
      // in time is a timeout.
      timeouts: { responseMs: 300, firstByteMs: 1000, bodyMs: 1000 },
      routes: (context) => [
        {
          id: 'public-site',
          match: { host: 'public.shuttle.test', path: '/' },
          upstream: context.upstreamA,
          auth: { mode: 'none' },
        },
        {
          id: 'unreachable',
          match: { host: 'unreachable.shuttle.test', path: '/' },
          upstream: 'http://127.0.0.1:1',
          auth: { mode: 'none' },
        },
      ],
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a body that is over the limit is refused with 413', async () => {
    const response = await fetch(`${harness.gatewayUrl}/echo`, {
      method: 'POST',
      headers: { host: 'public.shuttle.test', 'content-type': 'application/octet-stream' },
      body: new Uint8Array(2 * 1024 * 1024),
    })
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('payload_too_large')
  })

  test('an upstream that does not answer in time is a 504', async () => {
    const response = await fetch(`${harness.gatewayUrl}/delay-headers?ms=5000`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(504)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('gateway_timeout')
  })

  test('an upstream that cannot be reached is a 502', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'unreachable.shuttle.test' },
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('bad_gateway')
  })

  test('the message of a 502 does not name the upstream', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'unreachable.shuttle.test' },
    })
    const body = (await response.json()) as { error: string; message: string }
    expect(body.message).not.toContain('127.0.0.1')
    expect(body.message).not.toContain('unreachable')
  })

  test('a caller that goes away is counted as a 499', async () => {
    const controller = new AbortController()
    const pending = fetch(`${harness.gatewayUrl}/sse?count=1000&delay=100`, {
      headers: { host: 'public.shuttle.test' },
      signal: controller.signal,
    }).catch(() => null)
    await Bun.sleep(100)
    controller.abort()
    await pending

    // The caller is gone: there is nobody to answer. The status is
    // recorded, so the number of the callers that went away is known.
    await Bun.sleep(200)
    const metrics = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: 'Bearer test-metrics-token' },
    })
    const body = await metrics.text()
    expect(body).toContain('shuttle_requests_total{route="public-site",method="GET",status="499"}')
  })
})
