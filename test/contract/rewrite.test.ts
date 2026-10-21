import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The path the route forwards to its upstream.
 *
 * A route that does not declare a rewrite forwards the path of the
 * request: the upstream application sees the prefix of the route as part
 * of its own paths. A route that declares one writes the path of the
 * upstream instead, so an application that is mounted somewhere else does
 * not have to know the prefix of the gateway.
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
        id: 'plain',
        match: { host: 'api.shuttle.test', path: '/plain/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'stripped',
        match: { host: 'api.shuttle.test', path: '/stripped/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
        rewrite: '/{rest}',
      },
      {
        id: 'prefixed',
        match: { host: 'api.shuttle.test', path: '/prefixed/{workspaceId}/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
        rewrite: '/v1/workspaces/{workspaceId}/{rest}',
      },
      {
        id: 'fixed',
        match: { host: 'api.shuttle.test', path: '/fixed/' },
        upstream: context.upstreamA,
        auth: { mode: 'none' },
        rewrite: '/v1/fixed',
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

/** The path the upstream received. */
async function forwardedPath(path: string): Promise<{ path: string; query: unknown }> {
  const response = await fetch(`${harness.gatewayUrl}${path}`, {
    headers: { host: 'api.shuttle.test' },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { path: string; query: unknown }
  return body
}

describe('the path a route forwards', () => {
  test('a route that does not rewrite forwards the path of the request', async () => {
    const body = await forwardedPath('/plain/assets')
    expect(body.path).toBe('/plain/assets')
  })

  test('a rewrite forwards the rest of the path', async () => {
    const body = await forwardedPath('/stripped/assets')
    expect(body.path).toBe('/assets')
  })

  test('a rewrite forwards the values of the placeholders of the path', async () => {
    const body = await forwardedPath('/prefixed/11111111-1111-4111-8111-111111111111/assets')
    expect(body.path).toBe('/v1/workspaces/11111111-1111-4111-8111-111111111111/assets')
  })

  test('a rewrite without the rest does not forward the rest of the path', async () => {
    const body = await forwardedPath('/fixed/assets')
    expect(body.path).toBe('/v1/fixed')
  })

  test('the query string is forwarded unchanged', async () => {
    const response = await fetch(`${harness.gatewayUrl}/stripped/assets?x=1&y=2`, {
      headers: { host: 'api.shuttle.test' },
    })
    const body = (await response.json()) as { path: string; query: Record<string, string> }
    expect(body.path).toBe('/assets')
    expect(body.query).toEqual({ x: '1', y: '2' })
  })
})
