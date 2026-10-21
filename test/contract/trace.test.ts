import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'
import { METRICS_TOKEN } from './harness'

/**
 * The trace of a request and the latency of the upstream.
 *
 * The gateway writes its own span in the `traceparent` header it sends to
 * the upstream: the header of the caller is not forwarded as it is, so the
 * upstream always receives a well formed context and the span of the
 * upstream is a child of the span of the gateway.
 *
 * The latency of the upstream is a different number from the latency of
 * the gateway: the time the gateway spent on the authentication, on the
 * limits and on the access service is not part of it.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

/** The headers the upstream received. */
async function upstreamHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
  const response = await fetch(`${harness.gatewayUrl}/`, {
    headers: { host: 'public.shuttle.test', ...headers },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { headers: Record<string, string> }
  return body.headers
}

describe('the trace of a request', () => {
  test('the upstream receives a well formed traceparent', async () => {
    const headers = await upstreamHeaders({})
    const traceparent = headers.traceparent
    expect(traceparent).toBeDefined()
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  test('the trace of the caller continues', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const headers = await upstreamHeaders({
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    })
    // The id of the trace is the one of the caller, and the span is the
    // one of the gateway.
    expect(headers.traceparent).toBe(`00-${traceId}-${headers.traceparent?.split('-')[2]}-01`)
    expect(headers.traceparent?.split('-')[2]).not.toBe('00f067aa0ba902b7')
  })

  test('a malformed header of the caller is not forwarded', async () => {
    const headers = await upstreamHeaders({ traceparent: 'not-a-trace' })
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    expect(headers.traceparent).not.toBe('not-a-trace')
  })
})

describe('the latency of the upstream', () => {
  test('the metrics carry the latency of the upstream', async () => {
    await upstreamHeaders({})
    const metrics = await (
      await fetch(`${harness.gatewayUrl}/metrics`, {
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
    ).text()
    expect(metrics).toContain('shuttle_upstream_duration_seconds')
    expect(metrics).toContain('shuttle_upstream_duration_seconds_count{route="public-site"}')
  })
})
