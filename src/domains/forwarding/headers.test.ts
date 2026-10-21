import { describe, expect, test } from 'bun:test'
import {
  buildClientHeaders,
  buildUpstreamHeaders,
  connectionNominatedHeaders,
  resolveForwardingContext,
  stripGatewayCookies,
  writtenIdentity,
} from './index'

/** The cookies the gateway owns. */
const GATEWAY_COOKIES = ['shuttle_session', 'shuttle_oidc_state']

/** The context of a request that comes from a trusted proxy. */
function context(options: { forwardedFor?: string; proto?: string; host?: string } = {}) {
  const headers = new Headers()
  if (options.forwardedFor) headers.set('x-forwarded-for', options.forwardedFor)
  if (options.proto) headers.set('x-forwarded-proto', options.proto)
  headers.set('host', options.host ?? 'api.example.com')
  return resolveForwardingContext({
    peerAddress: '10.0.0.5',
    headers,
    trustedProxies: ['10.0.0.0/8'],
    externalProto: 'http',
  })
}

describe('the evaluation of the trusted proxies', () => {
  test('the headers of a trusted proxy are honoured', () => {
    const forwarding = context({ forwardedFor: '203.0.113.7', proto: 'https' })
    expect(forwarding.peerTrusted).toBe(true)
    expect(forwarding.clientIp).toBe('203.0.113.7')
    expect(forwarding.proto).toBe('https')
    expect(forwarding.chain).toEqual(['203.0.113.7', '10.0.0.5'])
  })

  test('the headers of a peer that is not trusted are ignored', () => {
    const forwarding = resolveForwardingContext({
      peerAddress: '198.51.100.9',
      headers: new Headers({ 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' }),
      trustedProxies: ['10.0.0.0/8'],
      externalProto: 'http',
    })
    expect(forwarding.peerTrusted).toBe(false)
    expect(forwarding.clientIp).toBe('198.51.100.9')
    expect(forwarding.proto).toBe('http')
    expect(forwarding.chain).toEqual(['198.51.100.9'])
  })

  test('the chain is read from the right', () => {
    // The right-most entry that is not a trusted proxy is the caller.
    const forwarding = context({ forwardedFor: '192.0.2.1, 203.0.113.7, 10.0.0.4' })
    expect(forwarding.clientIp).toBe('203.0.113.7')
    // The entries the client injected on the left are dropped.
    expect(forwarding.chain).toEqual(['203.0.113.7', '10.0.0.4', '10.0.0.5'])
  })

  test('a protocol that is not http is ignored', () => {
    expect(context({ proto: 'gopher' }).proto).toBe('http')
    expect(context({ proto: 'https' }).proto).toBe('https')
  })
})

describe('the headers that are forwarded upstream', () => {
  test('the identity of a client is never forwarded', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers({
        'x-shuttle-user': 'attacker',
        'x-shuttle-user-id': 'attacker',
        'x-shuttle-email': 'attacker@example.com',
        'x-shuttle-roles': 'admin',
        'x-shuttle-workspace': 'workspace',
        'x-shuttle-workspace-id': 'workspace',
        'x-shuttle-internal': '1',
        'x-shuttle-authenticated': '1',
        'x-shuttle-signature': 'v3=deadbeef',
        'x-forwarded-user': 'attacker',
        'x-forwarded-email': 'attacker@example.com',
        'x-forwarded-groups': 'admin',
        'x-remote-user': 'attacker',
        'x-remote-email': 'attacker@example.com',
      }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    for (const name of [
      'x-shuttle-user',
      'x-shuttle-email',
      'x-shuttle-roles',
      'x-shuttle-workspace',
      'x-shuttle-signature',
      'x-forwarded-user',
      'x-remote-user',
    ]) {
      expect(headers.get(name)).toBeNull()
    }
  })

  test('the forwarding headers of a client are replaced', () => {
    const forwarding = context({ forwardedFor: '203.0.113.7' })
    const headers = buildUpstreamHeaders({
      incoming: new Headers({
        'x-forwarded-for': '192.0.2.1',
        'x-forwarded-proto': 'gopher',
        'x-forwarded-host': 'evil.example.com',
        'x-real-ip': '192.0.2.1',
        host: 'api.example.com',
      }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.5')
    expect(headers.get('x-forwarded-proto')).toBe('http')
    expect(headers.get('x-forwarded-host')).toBe('api.example.com')
    expect(headers.get('x-real-ip')).toBe('203.0.113.7')
    expect(headers.get('host')).toBeNull()
  })

  test('the hop-by-hop headers are removed', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers({
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        te: 'trailers',
        trailer: 'x-thing',
        'proxy-authorization': 'Basic abc',
        upgrade: 'h2c',
      }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('keep-alive')).toBeNull()
    expect(headers.get('transfer-encoding')).toBeNull()
    expect(headers.get('te')).toBeNull()
    expect(headers.get('trailer')).toBeNull()
    expect(headers.get('proxy-authorization')).toBeNull()
    expect(headers.get('upgrade')).toBeNull()
  })

  test('the headers that the connection nominates are removed as well', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers({
        connection: 'x-secret, close',
        'x-secret': 'value',
        'x-keep': 'value',
      }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('x-secret')).toBeNull()
    expect(headers.get('x-keep')).toBe('value')
    expect(connectionNominatedHeaders(new Headers({ connection: 'x-secret, close' }))).toEqual([
      'x-secret',
      'close',
    ])
  })

  test('the standard forwarded header of a client is removed', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers({ forwarded: 'for=192.0.2.60;proto=http;by=203.0.113.43' }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('forwarded')).toBeNull()
  })

  test('the cookies of the gateway never reach an upstream', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers({
        cookie: 'shuttle_session=secret; shuttle_oidc_state=state; app=1; other=2',
      }),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('cookie')).toBe('app=1; other=2')
  })

  test('the name of a cookie is case sensitive', () => {
    expect(stripGatewayCookies('Shuttle_Session=secret; app=1', GATEWAY_COOKIES)).toBe(
      'Shuttle_Session=secret; app=1'
    )
    expect(stripGatewayCookies('shuttle_session=secret', GATEWAY_COOKIES)).toBe('')
  })

  test('the identity of the caller is written', () => {
    const forwarding = context()
    const identity = writtenIdentity({
      subject: 'user-1',
      email: 'user@example.com',
      roles: ['admin', 'dev'],
      workspaceId: 'workspace-1',
    })
    const headers = buildUpstreamHeaders({
      incoming: new Headers(),
      forwarding,
      identity,
      signature: 'v3=abc',
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('x-shuttle-user')).toBe('user-1')
    expect(headers.get('x-shuttle-email')).toBe('user@example.com')
    expect(headers.get('x-shuttle-roles')).toBe('admin,dev')
    expect(headers.get('x-shuttle-workspace')).toBe('workspace-1')
    expect(headers.get('x-shuttle-signature')).toBe('v3=abc')
  })

  test('a request without an identity carries no identity header', () => {
    const forwarding = context()
    const headers = buildUpstreamHeaders({
      incoming: new Headers(),
      forwarding,
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('x-shuttle-user')).toBeNull()
    expect(headers.get('x-shuttle-roles')).toBeNull()
    expect(headers.get('x-shuttle-signature')).toBeNull()
  })
})

describe('the headers of an answer', () => {
  test('the identity headers of an upstream are removed', () => {
    const headers = buildClientHeaders(
      new Headers({
        'x-shuttle-user': 'attacker',
        'x-shuttle-signature': 'v3=deadbeef',
        'x-forwarded-for': '10.0.0.1',
        'x-forwarded-proto': 'https',
        'x-real-ip': '10.0.0.1',
        connection: 'keep-alive',
        'content-type': 'application/json',
      }),
      GATEWAY_COOKIES
    )
    expect(headers.get('x-shuttle-user')).toBeNull()
    expect(headers.get('x-shuttle-signature')).toBeNull()
    expect(headers.get('x-forwarded-for')).toBeNull()
    expect(headers.get('x-forwarded-proto')).toBeNull()
    expect(headers.get('x-real-ip')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('an upstream cannot write a cookie of the gateway', () => {
    const upstream = new Headers()
    upstream.append('set-cookie', 'shuttle_session=attacker; Path=/')
    upstream.append('set-cookie', 'upstream_session=abc; Path=/')
    const headers = buildClientHeaders(upstream, GATEWAY_COOKIES)
    const cookies = headers.getSetCookie()
    expect(cookies).toEqual(['upstream_session=abc; Path=/'])
  })
})

describe('the authorization of the caller', () => {
  test('the header of the caller is forwarded by default', () => {
    const headers = buildUpstreamHeaders({
      incoming: new Headers({ authorization: 'Bearer the-token' }),
      forwarding: context(),
      gatewayCookies: GATEWAY_COOKIES,
    })
    expect(headers.get('authorization')).toBe('Bearer the-token')
  })

  test('a route that does not need it does not receive it', () => {
    const headers = buildUpstreamHeaders({
      incoming: new Headers({ authorization: 'Bearer the-token' }),
      forwarding: context(),
      gatewayCookies: GATEWAY_COOKIES,
      forwardAuthorization: false,
    })
    expect(headers.get('authorization')).toBeNull()
    // The identity of the caller still travels to the upstream.
    const withIdentity = buildUpstreamHeaders({
      incoming: new Headers({ authorization: 'Bearer the-token' }),
      forwarding: context(),
      identity: writtenIdentity({ subject: 'user-1', roles: [] }),
      gatewayCookies: GATEWAY_COOKIES,
      forwardAuthorization: false,
    })
    expect(withIdentity.get('authorization')).toBeNull()
    expect(withIdentity.get('x-shuttle-user')).toBe('user-1')
  })
})
