import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The upstreams of a route.
 *
 * A route may name one upstream or several: the gateway tries them in the
 * order of the list, and it tries the next one when the connection to the
 * first one fails.
 *
 * The next one is tried only when the request may be sent again: a request
 * that has a body cannot be replayed, and a request that changes the state
 * of an upstream may not be sent twice.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    routes: (context) => [
      {
        id: 'public-site',
        match: { host: 'public.shuttle.test', path: '/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'pooled',
        match: { host: 'api.shuttle.test', path: '/pooled/' },
        // The first upstream is not there: the connection is refused and
        // the gateway tries the second one.
        upstream: ['http://127.0.0.1:1/', context.upstreamB],
        auth: { mode: 'none' },
      },
      {
        id: 'single',
        match: { host: 'api.shuttle.test', path: '/single/' },
        upstream: ['http://127.0.0.1:1/'],
        auth: { mode: 'none' },
      },
      {
        id: 'hung',
        match: { host: 'api.shuttle.test', path: '/hung/' },
        // The first upstream accepts the connection and never answers: the
        // attempt is abandoned after its budget and the second one answers.
        upstream: [context.hung, context.upstreamB],
        auth: { mode: 'none' },
        timeouts: { upstreamAttemptMs: 300 },
      },
      {
        id: 'replayed',
        match: { host: 'echo.shuttle.test', path: '/' },
        // The first upstream is not there: the request is sent again to the
        // second one, with its body.
        upstream: ['http://127.0.0.1:1/', context.upstreamB],
        auth: { mode: 'none' },
        replayMaxBytes: 1024,
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the upstreams of a route', () => {
  test('the second upstream answers when the first one is not there', async () => {
    const response = await fetch(`${harness.gatewayUrl}/pooled/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-b')
  })

  test('a route whose only upstream is not there answers a bad gateway', async () => {
    const response = await fetch(`${harness.gatewayUrl}/single/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('bad_gateway')
  })

  test('an upstream that does not answer in time is left for the next one', async () => {
    const started = Date.now()
    const response = await fetch(`${harness.gatewayUrl}/hung/asset`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-b')
    // The attempt was abandoned after its budget, not after the whole
    // budget of the answer.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a request with a small body is sent again to the next upstream', async () => {
    const response = await fetch(`${harness.gatewayUrl}/echo`, {
      method: 'PUT',
      headers: { host: 'echo.shuttle.test', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string; body: string }
    expect(body.service).toBe('upstream-b')
    expect(body.body).toBe('{"hello":"world"}')
  })
})
