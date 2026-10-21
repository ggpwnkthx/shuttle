import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The trust of the forwarding headers.
 *
 * The headers that a proxy reports are only honoured when the peer that
 * opened the connection is a proxy the deployment trusts. A client that
 * connects to the gateway directly chooses the headers it sends, so the
 * gateway ignores them.
 */
describe('the forwarding headers of a proxy', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ trustedProxies: ['127.0.0.1/32'] })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the host of a trusted proxy decides the route', async () => {
    // The ingress rewrites the host of the request to its own name and
    // reports the host the caller used in `x-forwarded-host`.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'internal-gateway:8080',
        'x-forwarded-host': 'public.shuttle.test',
      },
    })
    expect(response.status).toBe(200)
  })

  test('the host a client reports is only honoured through a trusted proxy', async () => {
    // The peer is a trusted proxy here, so its `x-forwarded-host` decides
    // the route. The trust is in the peer, not in the header: a client that
    // connects to the gateway directly cannot choose the host.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'public.shuttle.test',
        'x-forwarded-host': 'nosuch.shuttle.test',
      },
    })
    expect(response.status).toBe(404)
  })

  test('the origin of a browser is compared with the host of the proxy', async () => {
    const login = await harness.login()
    // The browser sent the origin of the host it called. The gateway
    // compares it with the host the proxy reports, not with the name the
    // proxy rewrote the request to.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      method: 'POST',
      headers: {
        host: 'internal-gateway:8080',
        'x-forwarded-host': 'public.shuttle.test',
        'x-forwarded-proto': 'https',
        origin: 'https://public.shuttle.test',
        'sec-fetch-site': 'same-site',
        cookie: login.cookie,
      },
      body: 'x=1',
    })
    expect(response.status).toBe(200)
  })
})

describe('the forwarding headers of a client', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ trustedProxies: [] })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the host of an untrusted peer decides the route', async () => {
    // The peer is not a trusted proxy, so its `x-forwarded-host` is
    // ignored: the gateway routes the request with the host it sent.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'public.shuttle.test',
        'x-forwarded-host': 'nosuch.shuttle.test',
      },
    })
    expect(response.status).toBe(200)
  })

  test('a host that is not a host is ignored', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: {
        host: 'public.shuttle.test',
        'x-forwarded-host': 'not a host/with a path',
      },
    })
    expect(response.status).toBe(200)
  })
})
