/**
 * The pieces the application is built with.
 *
 * The application knows the interfaces of the domains and the observation
 * interfaces, never a concrete adapter: the runtime assembles the pieces
 * and hands them over here.
 */

import type { AuthenticationService } from '../domains/authentication'
import type { ConfigurationStore } from '../domains/configuration'
import type { HttpExchangeService } from '../domains/proxying'
import type { RequestLimiter } from '../domains/rate-limiting'
import type { AccessClient } from '../domains/workspace-access'
import type { Logger, Observer } from '../observability'

/**
 * The upgrade of a websocket connection.
 *
 * The websockets domain owns the handshake and the bridge; the application
 * hands it the request and the context of the route and answers the caller
 * with what it returns.
 */
export interface WebSocketDispatcher {
  /**
   * Handles an upgrade request.
   *
   * It answers the caller itself: the upgrade of the caller, the refusal of
   * the handshake and the errors of the upstream are all answers of the
   * gateway.
   */
  handle(request: Request, context: WebSocketContext): Promise<Response>
}

/** The context of an upgrade request. */
export interface WebSocketContext {
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
}

/** The settings of the browser that the application needs. */
export interface BrowserSettings {
  /** The `Secure` attribute of the cookies of the gateway. */
  cookieSecure: boolean
  /** The origins that are allowed in addition to the origin of the gateway. */
  allowedOrigins: string[]
  /** Refuse the navigations from another site as well. */
  csrfStrict: boolean
}

/** Everything the application needs to answer a request. */
export interface GatewayDependencies {
  /** The running configuration. */
  config: ConfigurationStore
  /** The authentication of the callers. */
  auth: AuthenticationService
  /** The decisions of the access service. */
  access: AccessClient
  /** The exchanges with the upstreams. */
  exchanges: HttpExchangeService
  /** The limiter of the requests of a caller over all the routes. */
  globalRateLimiter: RequestLimiter
  /** The limiter of the requests of a caller on one route. */
  rateLimiter: RequestLimiter
  /** The limiter of the login attempts. */
  loginRateLimiter: RequestLimiter
  /** The key of the signature of the identity. */
  identityKey: Buffer
  /** The names of the cookies of the gateway. */
  gatewayCookies: readonly string[]
  /** The settings of the browser. */
  browser: BrowserSettings
  /** The protocol the callers use towards the gateway. */
  externalProto: 'http' | 'https'
  /** The bearer token that guards the metrics endpoint. */
  metricsToken?: string
  /** The observer of the gateway. */
  observer: Observer
  /** The logger of the gateway. */
  logger: Logger
  /** The address of the peer of a request. */
  peerAddress: (request: Request) => string
  /** The upgrade of the websockets, when the deployment has them. */
  websockets?: WebSocketDispatcher
}
