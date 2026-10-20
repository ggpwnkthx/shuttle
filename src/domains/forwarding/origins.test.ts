import { describe, expect, test } from 'bun:test'
import {
  checkCrossSite,
  checkCrossSiteNavigation,
  checkWebsocketOrigin,
  normalizeOrigin,
  requestOrigin,
} from './index'

/** The options of a request of the site itself. */
function options(overrides: { strict?: boolean; allowedOrigins?: string[] } = {}) {
  return {
    method: 'GET',
    headers: new Headers(),
    host: 'app.example.com',
    externalProto: 'https' as const,
    allowedOrigins: overrides.allowedOrigins ?? [],
    strict: overrides.strict ?? false,
  }
}

describe('the origin of a request', () => {
  test('the default port is not part of the origin', () => {
    expect(normalizeOrigin('https://app.example.com:443')).toBe('https://app.example.com')
    expect(normalizeOrigin('http://app.example.com:80')).toBe('http://app.example.com')
    expect(normalizeOrigin('https://app.example.com:8443')).toBe('https://app.example.com:8443')
  })

  test('an origin with a path is malformed', () => {
    expect(normalizeOrigin('https://app.example.com/login')).toBeNull()
    expect(normalizeOrigin('not an origin')).toBeNull()
  })

  test('the origin of the gateway is the one the caller used', () => {
    expect(requestOrigin('app.example.com', 'https')).toBe('https://app.example.com')
    expect(requestOrigin('app.example.com:8443', 'https')).toBe('https://app.example.com:8443')
  })
})

describe('the guard of the cross site requests', () => {
  test('a request from another site that changes the state is refused', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'POST',
      headers: new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(false)
  })

  test('a request from another site that does not change the state is allowed by default', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'GET',
      headers: new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(true)
  })

  test('the strict mode refuses the navigations as well', () => {
    const check = checkCrossSite({
      ...options({ strict: true }),
      method: 'GET',
      headers: new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(false)
  })

  test('a request from an allowed origin is allowed', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'POST',
      headers: new Headers({
        'sec-fetch-site': 'cross-site',
        origin: 'https://app.example.com',
      }),
    })
    expect(check.allowed).toBe(true)
  })

  test('an origin of the list of the deployment is allowed', () => {
    const check = checkCrossSite({
      ...options({ allowedOrigins: ['https://portal.example.com'] }),
      method: 'POST',
      headers: new Headers({
        'sec-fetch-site': 'cross-site',
        origin: 'https://portal.example.com',
      }),
    })
    expect(check.allowed).toBe(true)
  })

  test('a sibling subdomain is not the same origin', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'POST',
      headers: new Headers({
        'sec-fetch-site': 'same-site',
        origin: 'https://sibling.example.com',
      }),
    })
    expect(check.allowed).toBe(false)
  })

  test('a request without the headers of a browser is allowed', () => {
    expect(checkCrossSite({ ...options(), method: 'POST' }).allowed).toBe(true)
  })

  test('an unknown value of the header is not a reason to refuse', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'POST',
      headers: new Headers({ 'sec-fetch-site': 'unknown-value' }),
    })
    expect(check.allowed).toBe(true)
  })

  test('a foreign origin without the header of the browser is refused when it changes the state', () => {
    const check = checkCrossSite({
      ...options(),
      method: 'POST',
      headers: new Headers({ origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(false)
  })
})

describe('the navigation of the logout', () => {
  test('a logout from another site is refused', () => {
    const check = checkCrossSiteNavigation({
      ...options(),
      headers: new Headers({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(false)
  })

  test('a logout from the site itself is allowed', () => {
    const check = checkCrossSiteNavigation({
      ...options(),
      headers: new Headers({ 'sec-fetch-site': 'same-origin', origin: 'https://app.example.com' }),
    })
    expect(check.allowed).toBe(true)
  })
})

describe('the origin of a websocket handshake', () => {
  test('a handshake without an origin is refused', () => {
    const check = checkWebsocketOrigin({ ...options(), headers: new Headers() })
    expect(check.allowed).toBe(false)
  })

  test('a handshake from another site is refused', () => {
    const check = checkWebsocketOrigin({
      ...options(),
      headers: new Headers({ origin: 'https://evil.example' }),
    })
    expect(check.allowed).toBe(false)
  })

  test('a handshake from the site itself is allowed', () => {
    const check = checkWebsocketOrigin({
      ...options(),
      headers: new Headers({ origin: 'https://app.example.com' }),
    })
    expect(check.allowed).toBe(true)
  })

  test('the strict mode does not change the rule of the handshake', () => {
    const allowed = checkWebsocketOrigin({
      ...options({ strict: true }),
      headers: new Headers({ origin: 'https://app.example.com' }),
    })
    expect(allowed.allowed).toBe(true)
    const refused = checkWebsocketOrigin({
      ...options({ strict: true }),
      headers: new Headers({ origin: 'https://evil.example' }),
    })
    expect(refused.allowed).toBe(false)
  })
})
