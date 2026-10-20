import { AccessClient } from '../auth/access'
import { RedisDecisionCache } from '../auth/decision-cache'
import { deriveIdentityKey } from '../auth/identity'
import { AuthService } from '../auth/service'
import { createSessionStore, type SessionStore } from '../auth/session'
import { OidcClient } from '../auth/oidc'
import { ConfigStore } from '../config/store'
import { createLogger, type LogLevel, type Logger } from '../log/logger'
import { MetricsStore } from '../metrics/store'
import { RateLimiter, RedisRateLimiter, type RequestLimiter } from '../gateway/ratelimit'
import { createRedisClient, isRedisUrl } from '../redis/client'

export interface OidcRuntimeOptions {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  audience?: string
  rolesClaim?: string
  /**
   * Allows an identity provider that is not served over https.
   *
   * Only for a development environment: a production deployment terminates
   * TLS in front of the identity provider.
   */
  allowInsecureIssuer?: boolean
}

export interface AccessRuntimeOptions {
  baseUrl: string
  token?: string
  timeoutMs?: number
  cacheTtlMs?: number
}

export interface SessionRuntimeOptions {
  /**
   * Connection url of the session store. The scheme selects the backend:
   * `memory://`, `redis://` or `rediss://`.
   */
  url: string
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix: string
  ttlMs: number
  touchIntervalMs: number
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** Maximum number of sessions of the in-process store. */
  maxSessions: number
}

export interface RuntimeOptions {
  configPath: string
  gatewayPort: number
  gatewayHost: string
  oidc: OidcRuntimeOptions
  access: AccessRuntimeOptions
  sessionSecret: string
  session: SessionRuntimeOptions
  /**
   * Url of the server that holds the state the replicas share: the rate
   * limits and the cached access decisions.
   *
   * There is none when the deployment has a single replica: the state then
   * lives in the memory of the process.
   */
  sharedStateUrl?: string
  /** Prefix of every key of the shared state. */
  sharedStateKeyPrefix: string
  /** PEM encoded certificate authority for a private endpoint. */
  sharedStateTlsCa?: string
  cookieSecure: boolean
  logLevel: LogLevel
  /** Bearer token that guards the `/metrics` endpoint. */
  metricsToken?: string
  maxBodyBytes: number
  websocketMaxBufferedBytes: number
  websocketMaxBufferedMessages: number
  /** The maximum size of a websocket message, in bytes. */
  websocketMaxPayloadBytes: number
  /** The number of bytes that may be queued for a client that does not read. */
  websocketBackpressureLimitBytes: number
  /** How often the gateway pings the open websockets, in milliseconds. */
  websocketPingIntervalMs: number
  /** How long a websocket may stay silent, in milliseconds. */
  websocketPongTimeoutMs: number
  /** The idle timeout of the websockets of the runtime, in seconds. */
  websocketIdleTimeoutSeconds: number
  /** Extra trusted proxy ranges on top of the ones in the configuration file. */
  trustedProxies: string[]
  /** Protocol used by clients towards the gateway (TLS is terminated upstream). */
  externalProto: 'http' | 'https'
  /**
   * How long a shutdown waits for the requests that are still in flight.
   *
   * The websockets are closed right away, the requests that are still
   * running get this amount of time to finish.
   */
  shutdownTimeoutMs: number
  /** The number of websocket connections that may be open at the same time. */
  websocketMaxConnections: number
  /** How long the gateway waits for the handshake of the upstream. */
  websocketHandshakeTimeoutMs: number
  /** The number of requests a single caller may make to one route in a window. */
  rateLimitMax: number
  /** The length of the window of the request limiter. */
  rateLimitWindowMs: number
  /**
   * The number of requests a single caller may make over all the routes in
   * a window.
   *
   * It is the protection against a flood. It is zero by default, so a
   * deployment that does not need it does not pay for it.
   */
  rateLimitGlobalMax: number
  /** The length of the window of the global request limiter. */
  rateLimitGlobalWindowMs: number
  /** The number of login attempts a single caller may make in a window. */
  loginRateLimitMax: number
  /** The length of the window of the login limiter. */
  loginRateLimitWindowMs: number
  /** The origins that are allowed to make requests to the gateway. */
  allowedOrigins: string[]
  /** Refuse the navigations from another site as well. */
  csrfStrict: boolean
}

export interface Runtime {
  options: RuntimeOptions
  logger: Logger
  config: ConfigStore
  metrics: MetricsStore
  sessions: SessionStore
  oidc: OidcClient
  access: AccessClient
  auth: AuthService
  /** The limiter of the requests that are forwarded to an upstream. */
  rateLimiter: RequestLimiter
  /**
   * The limiter of the requests of a caller over all the routes.
   *
   * It is the protection against a flood: the per route limiter alone
   * would let a caller make the budget of every route.
   */
  globalRateLimiter: RequestLimiter
  /** The limiter of the login attempts. */
  loginRateLimiter: RequestLimiter
  /** The key the identity headers are signed with. */
  identityKey: Buffer
  startedAt: number
  /** Closes the connections the runtime owns. */
  close: () => Promise<void>
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const logger = createLogger({ level: options.logLevel, bindings: { service: 'shuttle' } })
  const config = new ConfigStore(options.configPath)
  const metrics = new MetricsStore()
  const sessions = createSessionStore({
    url: options.session.url,
    keyPrefix: options.session.keyPrefix,
    ttlMs: options.session.ttlMs,
    touchIntervalMs: options.session.touchIntervalMs,
    tlsCa: options.session.tlsCa,
    maxSessions: options.session.maxSessions,
    logger,
  })
  const oidc = new OidcClient({
    issuer: options.oidc.issuer,
    clientId: options.oidc.clientId,
    clientSecret: options.oidc.clientSecret,
    redirectUri: options.oidc.redirectUri,
    scopes: options.oidc.scopes,
    audience: options.oidc.audience,
    rolesClaim: options.oidc.rolesClaim,
    allowInsecureIssuer: options.oidc.allowInsecureIssuer,
  })

  // The state the replicas share: the rate limits and the cached access
  // decisions. It lives in a Redis server when one is configured, and in
  // the memory of the process otherwise.
  const sharedClient = isRedisUrl(options.sharedStateUrl)
    ? createRedisClient({ url: options.sharedStateUrl!, tlsCa: options.sharedStateTlsCa })
    : undefined
  const onSharedStateError = (error: unknown): void => {
    logger.warn('the shared state is not reachable', { error })
    metrics.recordSharedStateError()
  }
  const decisionCache = sharedClient
    ? new RedisDecisionCache({
        client: sharedClient,
        keyPrefix: options.sharedStateKeyPrefix,
        onError: onSharedStateError,
      })
    : undefined
  const access = new AccessClient({
    baseUrl: options.access.baseUrl,
    token: options.access.token,
    timeoutMs: options.access.timeoutMs,
    cacheTtlMs: options.access.cacheTtlMs,
    cache: decisionCache,
    onError: (error) => logger.warn('access service request failed', { error }),
  })
  const auth = new AuthService({
    oidc,
    sessions,
    secret: options.sessionSecret,
    cookieSecure: options.cookieSecure,
    logger,
  })
  const limiterOptions = {
    max: options.rateLimitMax,
    windowMs: options.rateLimitWindowMs,
  }
  const rateLimiter: RequestLimiter = sharedClient
    ? new RedisRateLimiter({
        ...limiterOptions,
        client: sharedClient,
        keyPrefix: options.sharedStateKeyPrefix,
        onError: onSharedStateError,
      })
    : new RateLimiter(limiterOptions)
  const globalLimiterOptions = {
    max: options.rateLimitGlobalMax,
    windowMs: options.rateLimitGlobalWindowMs,
  }
  const globalRateLimiter: RequestLimiter = sharedClient
    ? new RedisRateLimiter({
        ...globalLimiterOptions,
        client: sharedClient,
        keyPrefix: `${options.sharedStateKeyPrefix}:global`,
        onError: onSharedStateError,
      })
    : new RateLimiter(globalLimiterOptions)
  const loginLimiterOptions = {
    max: options.loginRateLimitMax,
    windowMs: options.loginRateLimitWindowMs,
  }
  const loginRateLimiter: RequestLimiter = sharedClient
    ? new RedisRateLimiter({
        ...loginLimiterOptions,
        client: sharedClient,
        keyPrefix: options.sharedStateKeyPrefix,
        onError: onSharedStateError,
      })
    : new RateLimiter(loginLimiterOptions)
  return {
    options,
    logger,
    config,
    metrics,
    sessions,
    oidc,
    access,
    auth,
    rateLimiter,
    globalRateLimiter,
    loginRateLimiter,
    identityKey: deriveIdentityKey(options.sessionSecret),
    startedAt: Date.now(),
    close: async () => {
      await access.close()
      sharedClient?.close()
    },
  }
}

