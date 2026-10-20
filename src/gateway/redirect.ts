/**
 * Rewriting of the redirects of an upstream.
 *
 * An upstream application that is mounted under a prefix answers with
 * redirects that leave that prefix, and it may answer with an absolute url
 * that names its own internal host:
 *
 * ```
 * Location: http://upstream-b:3000/login      → the internal host leaks
 * Location: /login                            → the prefix is lost
 * ```
 *
 * The gateway rewrites both: the location stays relative, so the client
 * stays on the origin it already used, and it keeps the prefix the
 * application is mounted under.
 *
 * A redirect to a *different* host is never touched: an application that
 * sends the user to an external identity provider keeps working.
 */

export interface RedirectContext {
  /**
   * The origin of the upstream the request was sent to.
   *
   * A location that points at this origin is the upstream talking about
   * itself, and it is the one that has to be rewritten.
   */
  upstreamOrigin: string
  /**
   * The prefix the upstream application is mounted under, with a trailing
   * slash. An empty prefix means the application is mounted at the root.
   */
  mountPrefix: string
}

/**
 * Normalizes a prefix: it starts with a slash and it ends with one, and the
 * root is an empty string.
 */
export function normalizePrefix(prefix: string): string {
  if (!prefix || prefix === '/') return ''
  const trimmed = prefix.replace(/\/+$/, '')
  return trimmed === '' ? '' : `${trimmed}/`
}

/**
 * Reports whether a path already belongs to the prefix.
 *
 * The prefix itself and everything below it belong to it. A path that only
 * starts with the same characters (`/ws/abc` and `/ws/abcdef`) does not.
 */
function isUnderPrefix(path: string, prefix: string): boolean {
  if (!prefix) return true
  const withoutSlash = prefix.replace(/\/$/, '')
  return path === withoutSlash || path.startsWith(prefix)
}

/**
 * Puts a path under the prefix of the application, unless it already is.
 */
function applyPrefix(path: string, prefix: string): string {
  if (!prefix) return path
  if (isUnderPrefix(path, prefix)) return path
  return `${prefix}${path.replace(/^\/+/, '')}`
}

/**
 * Rewrites a location so that it stays inside the gateway.
 *
 * The rules:
 *
 * - a location that points at the upstream becomes relative: the internal
 *   hostname of the upstream never reaches the browser
 * - a relative location keeps the prefix the application is mounted under,
 *   unless it already carries it
 * - a location that points at another host is left alone
 */
export function rewriteLocation(location: string, context: RedirectContext): string {
  const value = location.trim()
  if (!value) return location

  const prefix = normalizePrefix(context.mountPrefix)

  // A protocol relative url (`//host/path`) is an absolute url without a
  // scheme, it is handled like one.
  if (value.startsWith('//')) {
    const parsed = parseAbsolute(`http:${value}`)
    if (!parsed) return location
    if (parsed.origin !== context.upstreamOrigin) return location
    return applyPrefix(`${parsed.pathname}${parsed.search}${parsed.hash}`, prefix)
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const parsed = parseAbsolute(value)
    if (!parsed) return location
    // A redirect to another host is none of the gateway's business.
    if (parsed.origin !== context.upstreamOrigin) return location
    // The location becomes relative, so the client stays on the origin it
    // used to reach the gateway.
    return applyPrefix(`${parsed.pathname}${parsed.search}${parsed.hash}`, prefix)
  }

  // A location that is only a query or a fragment stays as it is.
  if (value.startsWith('?') || value.startsWith('#')) return location

  // A relative location without a leading slash is resolved against the
  // current url by the client, the gateway leaves it alone.
  if (!value.startsWith('/')) return location

  return applyPrefix(value, prefix)
}

function parseAbsolute(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
