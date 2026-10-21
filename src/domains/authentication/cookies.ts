/**
 * The cookies of the gateway.
 *
 * The gateway authenticates a browser with a session cookie. That cookie is
 * a *credential*: whoever holds it is the caller. It must therefore never
 * leave the gateway, and an upstream must never be able to write it.
 *
 * The domain owns the names and the attributes of the cookies; the
 * application renders them into the answers.
 */

import { stringifySetCookie } from 'cookie'

/** The cookie that carries the id of the session of a browser caller. */
export const SESSION_COOKIE_NAME = 'shuttle_session'

/** The cookie that carries the state of a login that is in flight. */
export const STATE_COOKIE_NAME = 'shuttle_oidc_state'

/** Every cookie the gateway owns. */
export const GATEWAY_COOKIE_NAMES: readonly string[] = [SESSION_COOKIE_NAME, STATE_COOKIE_NAME]

/** The attributes of a cookie of the gateway. */
export interface GatewayCookieAttributes {
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax'
  path: '/'
  /** The lifetime of the cookie, in seconds. It is absent for a cookie that dies with the answer. */
  maxAge?: number
}

/** A cookie of the gateway, ready to be written into an answer. */
export interface GatewayCookie {
  name: string
  value: string
  attributes: GatewayCookieAttributes
}

/** The options of the cookies of the gateway. */
export interface CookieOptions {
  /** The `Secure` attribute of the cookies. */
  secure: boolean
}

/**
 * The cookie of a session.
 *
 * The cookie names the session and it follows it: its lifetime is the
 * lifetime that is left of the session, so the cookie never outlives the
 * session it names.
 */
export function sessionCookie(
  id: string,
  maxAgeSeconds: number,
  options: CookieOptions
): GatewayCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: id,
    attributes: {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: maxAgeSeconds,
    },
  }
}

/**
 * The cookie that deletes the session of the browser.
 *
 * The cookie is deleted with the same attributes it was created with: a
 * browser only replaces a cookie when the attributes match.
 */
export function sessionDeletionCookie(options: CookieOptions): GatewayCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    attributes: {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    },
  }
}

/**
 * The cookie that carries the state of a login that is in flight.
 *
 * The state is signed, not encrypted: it holds the challenge of the login
 * and the target of the redirect.
 */
export function loginStateCookie(
  value: string,
  maxAgeSeconds: number,
  options: CookieOptions
): GatewayCookie {
  return {
    name: STATE_COOKIE_NAME,
    value,
    attributes: {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: maxAgeSeconds,
    },
  }
}

/** The cookie that deletes the state of a login that is in flight. */
export function loginStateDeletionCookie(options: CookieOptions): GatewayCookie {
  return {
    name: STATE_COOKIE_NAME,
    value: '',
    attributes: {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    },
  }
}

/**
 * Renders a cookie into the value of a `Set-Cookie` header.
 *
 * The rendering is the one of the standard: the name and the value are
 * separated by an `=`, the attributes are separated by `; `.
 */
export function serializeCookie(cookie: GatewayCookie): string {
  return stringifySetCookie({
    name: cookie.name,
    value: cookie.value,
    path: cookie.attributes.path,
    httpOnly: cookie.attributes.httpOnly,
    secure: cookie.attributes.secure,
    sameSite: cookie.attributes.sameSite.toLowerCase() as 'lax',
    maxAge: cookie.attributes.maxAge,
  })
}
