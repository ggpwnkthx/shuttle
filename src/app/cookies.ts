/**
 * The cookies of a request.
 *
 * The application reads the cookies of the requests it answers: the cookie
 * of the session says whether the caller is a browser, and the cookie of the
 * state of the login is the proof that the login belongs to this browser.
 *
 * The names of the cookies are case sensitive: a cookie name is a name.
 */

/**
 * Reads a cookie of a `Cookie` header.
 *
 * The header is a list of `name=value` pairs that are separated by a
 * semicolon.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const index = trimmed.indexOf('=')
    if (index === -1) continue
    if (trimmed.slice(0, index).trim() !== name) continue
    return trimmed.slice(index + 1).trim()
  }
  return undefined
}
