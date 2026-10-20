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
import type { WebSocketServicePort } from '../domains/websockets'
import type { Logger, Observer } from '../observability'

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
  /** The version of the gateway, as the health endpoint reports it. */
  version: string
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
  /** True while the gateway is draining: it does not accept new work. */
  isDraining?: () => boolean
  /** The websockets of the gateway, when the deployment has them. */
  websockets?: WebSocketServicePort
}
