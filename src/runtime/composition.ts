/**
 * The composition root of the gateway.
 *
 * This is the only place where the concrete pieces are assembled: the
 * environment is read here, the clients and the stores are created here,
 * the domains are wired together here and the listener is started here.
 * Everything else receives its dependencies.
 */

import { createGatewayApp } from '../app/app'
import type { GatewayDependencies } from '../app/dependencies'
import { AuthenticationService } from '../domains/authentication'
import { MemorySessionStore, RedisSessionStore } from '../domains/authentication/adapters'
import { OidcClient } from '../domains/authentication'
import { ConfigurationStore } from '../domains/configuration'
import { deriveIdentityKey } from '../domains/forwarding'
import { HttpExchangeService } from '../domains/proxying'
import { MemoryRateLimiter } from '../domains/rate-limiting'
import { RedisRateLimiter } from '../domains/rate-limiting/adapters'
import { AccessClient } from '../domains/workspace-access'
import { MemoryDecisionCache } from '../domains/workspace-access/adapters'
import { RedisDecisionCache } from '../domains/workspace-access/adapters'
import { createLogger, type Logger } from '../observability'
import { MetricsStore, type Observer } from '../observability'
import { FetchAccessTransport } from '../platform/bun/access-transport'
import { BunHttpTransport } from '../platform/bun/http-transport'
import { startListener, type StartedListener } from '../platform/bun/listener'
import { createRedisClient, isRedisUrl } from '../platform/redis'
import type { RuntimeSettings } from './env'

/** The runtime of the gateway. */
export interface GatewayRuntime {
  /** The settings the runtime was built with. */
  settings: RuntimeSettings
  /** The logger of the gateway. */
  logger: Logger
  /** The observer of the gateway. */
  observer: Observer
  /** The running configuration. */
  config: ConfigurationStore
  /** The authentication of the callers. */
  auth: AuthenticationService
  /** The exchanges with the upstreams. */
  exchanges: HttpExchangeService
  /** The listener of the gateway. */
  listener: StartedListener
  /** Closes everything the runtime owns. */
  close: () => Promise<void>
}

/**
 * Builds the runtime of the gateway.
 *
 * The dependencies of the domains are assembled here and nowhere else: a
 * domain never builds a client and never reads the environment.
 */
export async function createRuntime(settings: RuntimeSettings): Promise<GatewayRuntime> {
  const logger = createLogger({
    level: settings.observability.logLevel,
    bindings: { service: 'shuttle' },
  })
  const observer = new MetricsStore()

  const config = new ConfigurationStore({
    source: settings.configPath,
    defaultMaxBodyBytes: settings.limits.maxBodyBytes,
    trustedProxies: settings.network.trustedProxies,
  })

  // The state the replicas share: the rate limits and the cached decisions.
  // It lives in a Redis server when one is configured, and in the memory of
  // the process otherwise.
  const sharedClient = isRedisUrl(settings.sharedState.url)
    ? createRedisClient({ url: settings.sharedState.url!, tlsCa: settings.sharedState.tlsCa })
    : undefined
  const onSharedStateError = (error: unknown): void => {
    logger.warn('the shared state is not reachable', { error })
    observer.recordSharedStateError()
  }

  // The store of the sessions. The scheme of the url selects the backend,
  // so the infrastructure only has to provide a single value.
  const sessions = isRedisUrl(settings.session.url)
    ? new RedisSessionStore({
        client: createRedisClient({
          url: settings.session.url,
          tlsCa: settings.session.tlsCa,
        }),
        keyPrefix: settings.session.keyPrefix,
        ttlMs: settings.session.ttlMs,
        maxAgeMs: settings.session.maxAgeMs,
        touchIntervalMs: settings.session.touchIntervalMs,
      })
    : new MemorySessionStore({
        ttlMs: settings.session.ttlMs,
        maxAgeMs: settings.session.maxAgeMs,
        touchIntervalMs: settings.session.touchIntervalMs,
        maxSessions: settings.session.maxSessions,
      })

  const oidc = new OidcClient({
    issuer: settings.oidc.issuer,
    clientId: settings.oidc.clientId,
    clientSecret: settings.oidc.clientSecret,
    redirectUri: settings.oidc.redirectUri,
    scopes: settings.oidc.scopes,
    audience: settings.oidc.audience,
    rolesClaim: settings.oidc.rolesClaim,
    allowInsecureIssuer: settings.oidc.allowInsecureIssuer,
  })

  const auth = new AuthenticationService({
    oidc,
    sessions,
    secret: settings.session.secret,
    cookies: { secure: settings.browser.cookieSecure },
    logger,
  })

  // The decisions of the access service are cached where the replicas share
  // their state, so every replica answers with the same decision.
  const decisionCache = sharedClient
    ? new RedisDecisionCache({
        client: sharedClient,
        keyPrefix: settings.sharedState.keyPrefix,
        onError: onSharedStateError,
      })
    : new MemoryDecisionCache()
  const access = new AccessClient({
    baseUrl: settings.access.baseUrl,
    token: settings.access.token,
    timeoutMs: settings.access.timeoutMs,
    cacheTtlMs: settings.access.cacheTtlMs,
    transport: new FetchAccessTransport(),
    cache: decisionCache,
    onError: (error) => logger.warn('the access service request failed', { error }),
  })

  // The limiters. A deployment with more than one replica shares its
  // windows, so the limit of the deployment is the configured limit.
  const limiterOptions = {
    max: settings.limits.route.max,
    windowMs: settings.limits.route.windowMs,
  }
  const rateLimiter = sharedClient
    ? new RedisRateLimiter({
        ...limiterOptions,
        client: sharedClient,
        keyPrefix: settings.sharedState.keyPrefix,
        onError: onSharedStateError,
      })
    : new MemoryRateLimiter(limiterOptions)
  const globalRateLimiter = sharedClient
    ? new RedisRateLimiter({
        max: settings.limits.global.max,
        windowMs: settings.limits.global.windowMs,
        client: sharedClient,
        keyPrefix: `${settings.sharedState.keyPrefix}:global`,
        onError: onSharedStateError,
      })
    : new MemoryRateLimiter({
        max: settings.limits.global.max,
        windowMs: settings.limits.global.windowMs,
      })
  const loginRateLimiter = sharedClient
    ? new RedisRateLimiter({
        max: settings.limits.login.max,
        windowMs: settings.limits.login.windowMs,
        client: sharedClient,
        keyPrefix: `${settings.sharedState.keyPrefix}:login`,
        onError: onSharedStateError,
      })
    : new MemoryRateLimiter({
        max: settings.limits.login.max,
        windowMs: settings.limits.login.windowMs,
      })

  const exchanges = new HttpExchangeService({ transport: new BunHttpTransport() })

  // The address of the peer of a request is known by the listener, which is
  // built after the application: the holder is filled in below.
  const peer = { address: (_request: Request) => '0.0.0.0' }

  const dependencies: GatewayDependencies = {
    config,
    auth,
    access,
    exchanges,
    rateLimiter,
    globalRateLimiter,
    loginRateLimiter,
    identityKey: deriveIdentityKey(settings.session.secret),
    gatewayCookies: auth.gatewayCookieNames,
    browser: {
      cookieSecure: settings.browser.cookieSecure,
      allowedOrigins: settings.browser.allowedOrigins,
      csrfStrict: settings.browser.csrfStrict,
    },
    externalProto: settings.network.externalProto,
    metricsToken: settings.observability.metricsToken,
    observer,
    logger,
    peerAddress: (request: Request) => peer.address(request),
  }

  const app = createGatewayApp(dependencies)
  const listener = startListener({
    app,
    host: settings.network.host,
    port: settings.network.port,
    onError: (error) => logger.error('the listener reported an error', { error }),
  })
  peer.address = listener.peerAddress

  return {
    settings,
    logger,
    observer,
    config,
    auth,
    exchanges,
    listener,
    close: async () => {
      await access.close()
      sharedClient?.close()
    },
  }
}
