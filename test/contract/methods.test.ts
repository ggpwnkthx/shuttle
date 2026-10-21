import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The methods of a route.
 *
 * A route may name the methods it accepts: a route that names `GET` does
 * not handle a `POST`, and a route that names no method handles every one.
 * Among the routes that match a request, the one that names the method of
 * the request wins over the one that names none.
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
        id: 'read',
        match: { host: 'api.shuttle.test', path: '/thing', methods: ['GET'] },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'write',
        match: { host: 'api.shuttle.test', path: '/thing', methods: ['POST'] },
        upstream: context.upstreamB,
        auth: { mode: 'none' },
      },
      {
        id: 'fallback',
        match: { host: 'api.shuttle.test', path: '/thing' },
        upstream: context.upstreamB,
        auth: { mode: 'none' },
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the methods of a route', () => {
  test('a route that names a method handles it', async () => {
    const response = await fetch(`${harness.gatewayUrl}/thing`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-a')
  })

  test('a route that names a method does not handle the other ones', async () => {
    const response = await fetch(`${harness.gatewayUrl}/thing`, {
      method: 'POST',
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    // The route that names `POST` wins over the route that names none.
    expect(body.service).toBe('upstream-b')
  })

  test('a method that no route names falls back to the route that names none', async () => {
    const response = await fetch(`${harness.gatewayUrl}/thing`, {
      method: 'DELETE',
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-b')
  })

  test('a route that names no method handles every method', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(200)
  })
})
