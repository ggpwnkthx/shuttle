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

/** One case of the guard: the request, and what the guard answers. */
interface CrossSiteCase {
  case: string
  method?: string
  headers?: Record<string, string>
  strict?: boolean
  allowedOrigins?: string[]
  allowed: boolean
}

describe('the guard of the cross site requests', () => {
  test.each<CrossSiteCase>([
    {
      case: 'a request from another site that changes the state is refused',
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      allowed: false,
    },
    {
      case: 'a request from another site that does not change the state is allowed by default',
      method: 'GET',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      allowed: true,
    },
    {
      case: 'the strict mode refuses the navigations as well',
      method: 'GET',
      strict: true,
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      allowed: false,
    },
    {
      case: 'a request from an allowed origin is allowed',
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://app.example.com' },
      allowed: true,
    },
    {
      case: 'an origin of the list of the deployment is allowed',
      method: 'POST',
      allowedOrigins: ['https://portal.example.com'],
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://portal.example.com' },
      allowed: true,
    },
    {
      case: 'a sibling subdomain is not the same origin',
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-site', origin: 'https://sibling.example.com' },
      allowed: false,
    },
    {
      case: 'a request without the headers of a browser is allowed',
      method: 'POST',
      allowed: true,
    },
    {
      case: 'an unknown value of the header is not a reason to refuse',
      method: 'POST',
      headers: { 'sec-fetch-site': 'unknown-value' },
      allowed: true,
    },
    {
      case: 'a foreign origin without the header of the browser is refused when it changes the state',
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      allowed: false,
    },
  ])('$case', ({ method, headers, strict, allowedOrigins, allowed }) => {
    const check = checkCrossSite({
      ...options({ strict, allowedOrigins }),
      method: method ?? 'GET',
      headers: new Headers(headers),
    })
    expect(check.allowed).toBe(allowed)
  })
})

describe('the navigation of the logout', () => {
  test.each<{ case: string; headers: Record<string, string>; allowed: boolean }>([
    {
      case: 'a logout from another site is refused',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      allowed: false,
    },
    {
      case: 'a logout from the site itself is allowed',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'https://app.example.com' },
      allowed: true,
    },
  ])('$case', ({ headers, allowed }) => {
    const check = checkCrossSiteNavigation({ ...options(), headers: new Headers(headers) })
    expect(check.allowed).toBe(allowed)
  })
})

describe('the origin of a websocket handshake', () => {
  test.each<{ case: string; headers: Record<string, string>; allowed: boolean }>([
    { case: 'a handshake without an origin is refused', headers: {}, allowed: false },
    {
      case: 'a handshake from another site is refused',
      headers: { origin: 'https://evil.example' },
      allowed: false,
    },
    {
      case: 'a handshake from the site itself is allowed',
      headers: { origin: 'https://app.example.com' },
      allowed: true,
    },
  ])('$case', ({ headers, allowed }) => {
    const check = checkWebsocketOrigin({ ...options(), headers: new Headers(headers) })
    expect(check.allowed).toBe(allowed)
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
