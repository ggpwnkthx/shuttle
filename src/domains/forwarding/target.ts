/**
 * The target of a forwarded request.
 *
 * The upstream is a base url and the request is a path and a query string:
 * the target is the base path of the upstream in front of the path of the
 * request, with the query string of the request.
 *
 * The path is forwarded unchanged: the prefix that matched the route is not
 * stripped and the path is not rewritten. The encoding of the path and of
 * the query string is the one the caller sent, so the target is built as a
 * string and not through the url parser, which would encode it again.
 */

/** The origin of an upstream, without its path. */
export function upstreamOrigin(upstream: string): string {
  try {
    return new URL(upstream).origin
  } catch {
    return ''
  }
}

/**
 * Builds the url of the upstream for a request.
 *
 * - the base path of the upstream is taken, its trailing slashes removed
 * - the path of the request is appended (it always starts with `/`)
 * - the query string of the request is used as the query string of the
 *   upstream; the query string of the upstream itself does not exist
 * - the fragment is never forwarded
 */
export function buildUpstreamTarget(upstream: string, path: string, search: string): string {
  const base = new URL(upstream)
  const basePath = base.pathname.replace(/\/+$/, '')
  const requestPath = path.startsWith('/') ? path : `/${path}`
  return `${base.origin}${basePath}${requestPath}${search}`
}

/**
 * Builds the url of the upstream for a websocket.
 *
 * The url is built the same way as the one of an http request, with `http`
 * replaced by `ws` and `https` by `wss`.
 */
export function buildWebsocketTarget(upstream: string, path: string, search: string): string {
  const target = buildUpstreamTarget(upstream, path, search)
  if (target.startsWith('https://')) return `wss://${target.slice('https://'.length)}`
  if (target.startsWith('http://')) return `ws://${target.slice('http://'.length)}`
  return target
}

/**
 * Rewrites the location of an answer of an upstream.
 *
 * A location that names the upstream itself is made relative: the internal
 * hostname of the upstream never reaches the browser. A location that names
 * another host is left alone: an application that sends the user to an
 * external identity provider keeps working.
 */
export function rewriteLocation(location: string, options: { upstreamOrigin: string }): string {
  const value = location.trim()
  if (!value) return location
  const origin = options.upstreamOrigin
  if (!origin) return location

  // A protocol relative url (`//host/path`) is an absolute url without a
  // scheme, it is handled like one.
  if (value.startsWith('//')) {
    const parsed = parseAbsolute(`http:${value}`)
    if (!parsed || parsed.origin !== origin) return location
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const parsed = parseAbsolute(value)
    if (!parsed || parsed.origin !== origin) return location
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  return location
}

/** Parses an absolute url, or null when it is not one. */
function parseAbsolute(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
