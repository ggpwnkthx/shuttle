/**
 * The cookies that belong to the gateway.
 *
 * The gateway authenticates a browser with a session cookie. That cookie is
 * a *credential*: whoever holds it is the caller. It must therefore never
 * leave the gateway, and an upstream must never be able to write it.
 *
 * The names are defined here so that the session service, the header policy
 * and the tests all use the same ones.
 */

/** The cookie that carries the id of the session of a browser caller. */
export const SESSION_COOKIE_NAME = 'shuttle_session'

/** The cookie that carries the state of a login that is in flight. */
export const STATE_COOKIE_NAME = 'shuttle_oidc_state'

/** Every cookie the gateway owns. */
export const GATEWAY_COOKIES = [SESSION_COOKIE_NAME, STATE_COOKIE_NAME] as const

/**
 * Reports whether a cookie name belongs to the gateway.
 *
 * The comparison is case sensitive: a cookie name is case sensitive, and
 * `Shuttle_Session` is a cookie of another name.
 */
export function isGatewayCookie(name: string): boolean {
  return (GATEWAY_COOKIES as readonly string[]).includes(name)
}

/**
 * The name of a cookie of a `Cookie` header.
 *
 * A `Cookie` header is a list of `name=value` pairs that are separated by
 * a semicolon. The name is the part in front of the first `=`.
 */
export function cookieNameOf(pair: string): string {
  const index = pair.indexOf('=')
  return (index === -1 ? pair : pair.slice(0, index)).trim()
}

/**
 * Removes the cookies of the gateway from a `Cookie` header.
 *
 * The cookies of the upstream application are kept: they belong to the
 * application, not to the gateway. The cookies of the gateway are removed,
 * because a session id is a credential of the caller and an upstream that
 * holds it can act as the caller.
 */
export function stripGatewayCookies(cookieHeader: string | null | undefined): string {
  if (!cookieHeader) return ''
  const kept = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !isGatewayCookie(cookieNameOf(part)))
  return kept.join('; ')
}

/**
 * Reports whether a `Set-Cookie` value writes a cookie of the gateway.
 *
 * An upstream that is able to write `shuttle_session` would be able to fix
 * the session of the browser to an id of its choice, and to log the browser
 * out. The gateway owns the name, so the upstream must not write it.
 */
export function isGatewaySetCookie(setCookieValue: string): boolean {
  const name = setCookieValue.split(';')[0] ?? ''
  return isGatewayCookie(cookieNameOf(name))
}
