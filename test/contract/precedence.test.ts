import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The precedence of the routes.
 *
 * The specificity of the host is decided before the method: a route of a
 * more specific host is never shadowed by a route of a less specific one,
 * not even when the less specific one names the method of the request.
 *
 * The catch-all of this table names `GET`, and the host of the request has
 * a route of its own. Before the fix, the catch-all answered the `GET` of
 * that host, and the policy of the route of the host — its authentication,
 * its limits, its upstream — was never applied to those requests.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    routes: (context) => [
      {
        id: 'admin',
        match: { host: 'admin.shuttle.test', path: '/' },
        upstream: context.upstreamA,
        auth: { mode: 'session' },
      },
      {
        id: 'catch-all-get',
        match: { host: '*', path: '/', methods: ['GET'] },
        upstream: context.upstreamB,
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the precedence of the routes', () => {
  test('the route of the host answers the request of that host', async () => {
    // The route of the host asks for a session: the request is refused.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'admin.shuttle.test' },
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('unauthorized')
  })

  test('the catch-all does not answer for a host that has a route of its own', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'admin.shuttle.test' },
    })
    expect(response.status).toBe(401)
  })

  test('the route of the host answers a caller that signed in', async () => {
    const session = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'admin.shuttle.test', cookie: session.cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    // The upstream of the route of the host, and not the one of the
    // catch-all.
    expect(body.service).toBe('upstream-a')
  })

  test('the catch-all still answers for the hosts that have no route', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'other.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-b')
  })
})
