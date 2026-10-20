/**
 * The state of a login that is in flight.
 *
 * The state holds the challenge of the login (the state, the nonce and the
 * verifier of the PKCE) and the target of the redirect after the login. It
 * travels in a cookie of the browser, so it is signed: a cookie that was
 * changed by the client is refused.
 *
 * A signed cookie is not an encrypted cookie: the state does not hold a
 * secret, it holds a challenge.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The state of a login that is in flight. */
export interface LoginState {
  /** The state of the request, as the provider knows it. */
  state: string
  /** The nonce of the request, as the provider knows it. */
  nonce: string
  /** The verifier of the PKCE challenge. */
  verifier: string
  /** The target of the redirect after the login. */
  redirect: string
  /** The moment the state expires, in milliseconds. */
  exp: number
}

/** The lifetime of the state of a login, in milliseconds. */
export const LOGIN_STATE_TTL_MS = 10 * 60_000

/**
 * Signs the state of a login.
 *
 * The value is `<payload>.<signature>`: the payload is the state, encoded,
 * and the signature is the HMAC of the payload with the secret of the
 * gateway.
 */
export function signLoginState(state: LoginState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/**
 * Verifies the state of a login.
 *
 * A cookie that was tampered with, a cookie that was signed with another
 * secret, a cookie that is not a state at all and a cookie that expired are
 * all refused: the login cannot be completed with them.
 */
export function verifyLoginState(
  value: string | undefined | null,
  secret: string,
  now: number = Date.now()
): LoginState | null {
  if (!value) return null
  const separator = value.lastIndexOf('.')
  if (separator <= 0) return null
  const payload = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null

  let state: LoginState
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LoginState
  } catch {
    return null
  }
  if (typeof state.state !== 'string' || typeof state.nonce !== 'string') return null
  if (typeof state.verifier !== 'string' || typeof state.redirect !== 'string') return null
  if (typeof state.exp !== 'number') return null
  if (state.exp < now) return null
  return state
}

/**
 * The target of the redirect after a login.
 *
 * Only a relative path with a single slash is accepted. A target that a
 * browser would resolve to another origin is an open redirect, and a
 * control character in the value of a `Location` header is an injection:
 * browsers strip the tabs and the newlines of an url before they resolve
 * it, so `/\t/evil.example` would leave the site.
 */
export function sanitizeRedirectTarget(value: string | undefined | null): string {
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  if (value.includes('\\')) return '/'
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return '/'
  }
  return value
}
