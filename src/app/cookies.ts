/**
 * The cookies of a request.
 *
 * The application reads the cookies of the requests it answers: the cookie
 * of the session says whether the caller is a browser, and the cookie of
 * the state of the login is the proof that the login belongs to this
 * browser.
 *
 * The parsing is the one of the forwarding domain, so the gateway reads a
 * cookie and forwards it with the same rules.
 */

import { parseCookieHeader } from '../domains/forwarding'

/**
 * Reads a cookie of a `Cookie` header.
 *
 * The name of a cookie is case sensitive: a cookie name is a name.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  return parseCookieHeader(header)[name]
}
