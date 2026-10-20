import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { truncateCloseReason } from '../src/gateway/websocket'
import { buildUpstreamHeaders, resolveForwarding } from '../src/gateway/headers'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The hardening of the gateway: the parts that protect the process and the
 * callers from the requests they did not expect.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

describe('the close reason of a websocket', () => {
  test('a reason that fits is kept', () => {
    expect(truncateCloseReason('the client is too slow')).toBe('the client is too slow')
    expect(truncateCloseReason('')).toBe('')
    expect(truncateCloseReason(undefined)).toBe('')
  })

  test('a reason that is too long is cut on a character boundary', () => {
    // The protocol reserves 125 bytes for the code and the reason, so a
    // reason may not be longer than 123 bytes. A reason that is longer is
    // refused by the other side, and a refused close frame leaves the
    // connection hanging.
    const reason = 'x'.repeat(200)
    const truncated = truncateCloseReason(reason)
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(123)
    expect(truncated).toBe('x'.repeat(123))
  })

  test('a multi byte character is not cut in half', () => {
    const reason = 'é'.repeat(200)
    const truncated = truncateCloseReason(reason)
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(123)
    // The result is a valid string: the last character is complete.
    expect(truncated.endsWith('é')).toBe(true)
  })
})

describe('the roles of the caller', () => {
  test('a role that would make the list ambiguous is not written', () => {
    const headers = buildUpstreamHeaders({
      incoming: new Headers(),
      forwarding: {
        peerAddress: '127.0.0.1',
        peerTrusted: false,
        clientIp: '127.0.0.1',
        proto: 'http',
        host: 'api.shuttle.test',
      },
      identity: {
        subject: 'alice',
        roles: ['admin', 'member', 'a,b'],
      },
    })
    expect(headers.get('x-shuttle-roles')).toBe('admin,member')
  })
})

describe('the forwarding headers', () => {
  test('the forwarding headers of an untrusted peer are ignored', () => {
    const forwarding = resolveForwarding({
      peerAddress: '203.0.113.7',
      incoming: new Headers({
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
      }),
      trustedProxies: ['10.0.0.0/8'],
      tls: false,
    })
    expect(forwarding.peerTrusted).toBe(false)
    expect(forwarding.clientIp).toBe('203.0.113.7')
    expect(forwarding.proto).toBe('http')
  })

  test('the forwarding headers of a trusted peer are used', () => {
    const forwarding = resolveForwarding({
      peerAddress: '10.1.2.3',
      incoming: new Headers({
        'x-forwarded-for': '1.2.3.4, 10.1.2.3',
        'x-forwarded-proto': 'https',
      }),
      trustedProxies: ['10.0.0.0/8'],
      tls: false,
    })
    expect(forwarding.peerTrusted).toBe(true)
    expect(forwarding.clientIp).toBe('1.2.3.4')
    expect(forwarding.proto).toBe('https')
  })

  test('a protocol that is not http or https is ignored', () => {
    const forwarding = resolveForwarding({
      peerAddress: '10.1.2.3',
      incoming: new Headers({ 'x-forwarded-proto': 'javascript' }),
      trustedProxies: ['10.0.0.0/8'],
      tls: true,
    })
    expect(forwarding.proto).toBe('https')
  })
})

describe('the logout of the gateway', () => {
  test('a logout from another site is refused', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/auth/logout`, {
      redirect: 'manual',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    })
    expect(response.status).toBe(403)
  })

  test('a logout of the site itself destroys the session', async () => {
    const login = await harness.login()
    const response = await fetch(`${harness.gatewayUrl}/auth/logout`, {
      redirect: 'manual',
      headers: {
        host: 'api.shuttle.test',
        cookie: login.cookie,
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(response.status).toBe(302)
    // The session is gone: the caller is not authenticated any more.
    const after = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(after.status).toBe(401)
  })
})
