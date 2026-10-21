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
})
