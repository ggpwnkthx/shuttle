/**
 * The cookies of the gateway.
 *
 * The format of a `Cookie` header and of a `Set-Cookie` header is defined
 * by the specification (RFC 6265). The parsing and the rendering are done
 * by the library that implements it, so the edge cases are the ones of the
 * standard and not the ones of a second implementation:
 *
 * - a value that carries a percent escape is decoded, and the quotes that
 *   delimit a value are not part of it;
 * - a value that carries an `=` is a value, not a pair of values;
 * - the `Expires` of a `Set-Cookie` carries a comma, so a cookie is not
 *   split on it.
 *
 * The name of a cookie is case sensitive: `Shuttle_Session` is a cookie of
 * another name and it does not belong to the gateway.
 */

import { parseCookie, parseSetCookie, stringifyCookie } from 'cookie'

/**
 * Decodes the value of a cookie.
 *
 * The percent escapes are decoded, and the quotes that delimit a value are
 * removed: they are delimiters, not part of the value. A value that cannot
 * be decoded is kept as it is: a broken value is not a reason to drop the
 * cookie of the caller.
 */
function decodeCookieValue(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    decoded = value
  }
  if (decoded.length >= 2 && decoded.startsWith('"') && decoded.endsWith('"')) {
    return decoded.slice(1, -1)
  }
  return decoded
}

/**
 * Parses a `Cookie` header into the cookies it carries.
 *
 * When a name appears twice, the **first** value is kept: a browser sends
 * the cookie of the longest path first, so the first value is the one of
 * the most specific cookie, and it is the one the caller expects.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header) return {}
  const parsed = parseCookie(header, { decode: decodeCookieValue })
  const cookies: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined) continue
    cookies[name] = value
  }
  return cookies
}

/**
 * Renders the cookies into a `Cookie` header.
 *
 * The order of the cookies is the order of the object, so the header of the
 * caller keeps its order.
 *
 * A cookie whose name the standard does not allow is **not** rendered: the
 * other cookies of the header are rendered, and the malformed one is
 * dropped. A client cannot break the gateway with a malformed header, and
 * a cookie of another site does not cost the caller its own cookies.
 */
export function renderCookieHeader(cookies: Record<string, string>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(cookies)) {
    try {
      const rendered = stringifyCookie({ [name]: value })
      if (rendered.length > 0) parts.push(rendered)
    } catch {
      // The name of the cookie is not one the standard allows: the cookie
      // is not rendered.
    }
  }
  return parts.join('; ')
}

/**
 * The name of the cookie a `Set-Cookie` header writes.
 *
 * A header that carries no `=` is not a valid cookie. The whole value is
 * then treated as the name, so a malformed cookie of the gateway is still
 * recognized as one and does not reach the browser.
 */
export function cookieNameOf(setCookieValue: string): string {
  const parsed = parseSetCookie(setCookieValue)
  if (parsed.name) return parsed.name
  const head = setCookieValue.split(';')[0]?.trim() ?? ''
  return head.includes('=') ? '' : head
}
