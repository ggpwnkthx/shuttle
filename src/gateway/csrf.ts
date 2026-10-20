/**
 * The cross site guard of the gateway.
 *
 * A caller that authenticates with a session cookie is a browser, and a
 * browser can be made to send a request to the gateway from another site.
 * The guard refuses those requests.
 *
 * The rules are the ones the browsers make possible:
 *
 * - `Sec-Fetch-Site` says where the request comes from. A request from
 *   another site that changes the state of an upstream is refused.
 * - `Origin` says which origin the request comes from. An origin that is not
 *   the origin of the gateway is refused for the methods that change the
 *   state of an upstream.
 *
 * A request without both headers comes from a client that is not a browser
 * (a command line tool, a service), and it is allowed: a server to server
 * call is not a cross site request.
 *
 * A navigation from another site (a link in an e-mail, a search result) is
 * allowed by default, because refusing it breaks every deep link into an
 * application. The strict mode refuses it as well; it is the mode for a
 * deployment where the upstreams never change the state of anything on a
 * `GET`.
 */

export interface CrossSiteCheck {
  allowed: boolean
  /** Why the request was refused. */
  reason?: string
}

export interface CrossSiteOptions {
  method: string
  headers: Headers
  /** The host the client asked for. */
  host: string
  /**
   * The protocol the client used towards the gateway.
   *
   * It is the effective protocol: the one of the trusted forwarding headers
   * when the peer is a trusted proxy, the configured one otherwise. A wrong
   * value would refuse the legitimate requests of the site itself.
   */
  externalProto: 'http' | 'https'
  /** Origins that are allowed in addition to the origin of the gateway. */
  allowedOrigins: string[]
  /**
   * Refuse the navigations from another site as well.
   *
   * The default is false: a link in an e-mail points at the application from
   * another site, and refusing it would break every deep link.
   */
  strict?: boolean
}

/** The methods that change the state of an upstream. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Normalizes an origin for the comparison.
 *
 * The scheme and the host are case insensitive, the default port of the
 * scheme is not part of the origin a browser sends, and an origin never
 * carries a path. An origin that carries one is malformed and is refused.
 */
export function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  const scheme = url.protocol === 'https:' ? 'https' : 'http'
  const defaultPort = scheme === 'https' ? '443' : '80'
  const host = url.hostname.toLowerCase()
  const port = url.port === '' || url.port === defaultPort ? '' : `:${url.port}`
  return `${scheme}://${host}${port}`
}

/** The origin of the gateway, as the client sees it. */
export function requestOrigin(host: string, externalProto: 'http' | 'https'): string {
  const scheme = externalProto
  const defaultPort = scheme === 'https' ? '443' : '80'
  const lower = host.trim().toLowerCase()
  // The port of the host is kept, it is part of the origin of the browser.
  const separator = lower.lastIndexOf(':')
  const port = separator > -1 ? lower.slice(separator + 1) : ''
  const hostname = separator > -1 ? lower.slice(0, separator) : lower
  const suffix = port !== '' && port !== defaultPort ? `:${port}` : ''
  return `${scheme}://${hostname}${suffix}`
}

/**
 * Reports whether an origin is allowed to make requests to the gateway.
 */
function isAllowedOrigin(origin: string, options: CrossSiteOptions): boolean {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  if (normalized === requestOrigin(options.host, options.externalProto)) return true
  return options.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized)
}

/**
 * Reports whether a request comes from another site.
 *
 * A link on another site must not be able to change the state of the
 * gateway: a logout that is triggered from another site is a nuisance the
 * caller did not ask for.
 *
 * The check is deliberately narrower than the one of the unsafe methods: a
 * navigation without the headers of the browser is allowed, because a link
 * in an e-mail points at the application from another site.
 */
export function checkCrossSiteNavigation(options: CrossSiteOptions): CrossSiteCheck {
  const fetchSite = options.headers.get('sec-fetch-site')?.trim().toLowerCase()
  if (fetchSite === 'cross-site') {
    const origin = options.headers.get('origin')?.trim() ?? ''
    if (origin !== '' && isAllowedOrigin(origin, options)) return { allowed: true }
    return { allowed: false, reason: 'the request was made from another site' }
  }
  const origin = options.headers.get('origin')?.trim() ?? ''
  if (origin !== '' && !isAllowedOrigin(origin, options)) {
    return { allowed: false, reason: `the origin "${origin}" is not allowed` }
  }
  return { allowed: true }
}

/**
 * Refuses the requests that a browser made on behalf of another site.
 */
export function checkCrossSite(options: CrossSiteOptions): CrossSiteCheck {
  const origin = options.headers.get('origin')?.trim() ?? ''
  const originAllowed = origin !== '' && isAllowedOrigin(origin, options)
  const unsafe = UNSAFE_METHODS.has(options.method.toUpperCase())

  const fetchSite = options.headers.get('sec-fetch-site')?.trim().toLowerCase()
  if (fetchSite) {
    if (fetchSite === 'cross-site') {
      // A platform that is spread over several domains needs the origins it
      // uses to be allowed explicitly.
      if (originAllowed) return { allowed: true }
      if (unsafe) {
        return { allowed: false, reason: 'the request was made from another site' }
      }
      if (options.strict) {
        return { allowed: false, reason: 'the request was made from another site' }
      }
      return { allowed: true }
    }
    if (fetchSite === 'same-site') {
      // `same-site` means the same *registrable domain*, not the same
      // origin: a sibling subdomain is `same-site` but a different origin.
      // The `Origin` header is the one that says which origin it was, so a
      // request from a sibling subdomain is a cross origin request and it
      // is refused like one when it changes the state of an upstream.
      if (origin !== '' && !originAllowed) {
        if (unsafe) {
          return { allowed: false, reason: `the origin "${origin}" is not allowed` }
        }
        if (options.strict) {
          return { allowed: false, reason: `the origin "${origin}" is not allowed` }
        }
      }
      return { allowed: true }
    }
    if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
      // An unknown value is not a reason to refuse a request.
      return { allowed: true }
    }
    return { allowed: true }
  }

  // Without `Sec-Fetch-Site` the origin is the only signal. A request that
  // changes the state of an upstream is refused when it comes from another
  // origin.
  if (origin !== '' && !originAllowed && unsafe) {
    return { allowed: false, reason: `the origin "${origin}" is not allowed` }
  }
  return { allowed: true }
}
