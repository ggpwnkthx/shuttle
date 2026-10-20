/**
 * The context of an upgrade of a websocket.
 *
 * The application assembles it: it knows the route, the identity of the
 * caller and the answers that are already staged for the request.
 */
export interface WebSocketUpgradeContext {
  /** The id of the route the request came in on. */
  routeId: string
  /** The base url of the upstream of the route. */
  upstream: string
  /** The path of the request. */
  path: string
  /** The query string of the request. */
  search: string
  /** The method of the request. */
  method: string
  /** The headers of the request. */
  headers: Headers
  /** The identity of the caller, when it was authenticated. */
  identity?: { subject: string; email?: string; roles: string[]; workspaceId?: string }
  /** The signature of the identity. */
  signature?: string
  /** The identifier of the request. */
  requestId: string
  /** The cookies that have to be written into the answer of the handshake. */
  cookies: string[]
  /** True when the request carries the cookie of the session of the gateway. */
  carriesSessionCookie: boolean
  /** The host the caller used. */
  host: string
  /** The protocol the caller used towards the gateway. */
  externalProto: 'http' | 'https'
  /** The origins that are allowed in addition to the origin of the gateway. */
  allowedOrigins: string[]
}
