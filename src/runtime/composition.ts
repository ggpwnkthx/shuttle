/**
 * The composition root of the gateway.
 *
 * This is the only place where the concrete pieces are assembled: the
 * environment is read here, the clients and the stores are created here,
 * the domains are wired together here and the listener is started here.
 * Everything else receives its dependencies.
 */

import { createGatewayApp, createGatewayHandler } from '../app/app'
import { AdmissionController } from '../app/admission'
import type { GatewayDependencies } from '../app/dependencies'
import { AuthenticationService } from '../domains/authentication'
import type { SessionStore } from '../domains/authentication'
import {
  MemorySessionStore,
  PostgresSessionStore,
  RedisSessionStore,
} from '../domains/authentication/adapters'
import { OidcClient } from '../domains/authentication'
import { ConfigurationStore } from '../domains/configuration'
import { asymmetricIdentityKey, ephemeralIdentityKey } from '../domains/forwarding'
import { HttpExchangeService, UpstreamBreaker } from '../domains/proxying'
import { MemoryRateLimiter, type RequestLimiter } from '../domains/rate-limiting'
import { FallbackRateLimiter, type RateLimitFallbackMode } from '../domains/rate-limiting'
import { PostgresRateLimiter, RedisRateLimiter } from '../domains/rate-limiting/adapters'
import { AccessClient } from '../domains/workspace-access'
import type { DecisionCache } from '../domains/workspace-access'
import { ReservationManager, WebSocketService } from '../domains/websockets'
import {
  MemoryDecisionCache,
  PostgresDecisionCache,
  RedisDecisionCache,
} from '../domains/workspace-access/adapters'
import { createLogger, type Logger } from '../observability'
import { logActiveConfiguration } from './policy-log'
import { MetricsStore, type Observer } from '../observability'
import { FetchAccessTransport } from '../platform/bun/access-transport'
import { createWebSocketHandlers } from '../platform/bun/client-upgrade'
import { BunHttpTransport } from '../platform/bun/http-transport'
import { WsUpstreamHandshake } from '../platform/bun/upstream-websocket'
import { startListener, type StartedListener } from '../platform/bun/listener'
import { drain as drainRuntime } from './lifecycle'
import { VERSION } from './version'
import { createRedisClient, isRedisUrl, withRetries } from '../platform/redis'
import type { SharedStateClient } from '../platform/redis'
import {
  createPostgresClient,
  ensureSchema,
  isPostgresUrl,
  withPostgresRetries,
} from '../platform/postgres'
import type { PostgresClient } from '../platform/postgres'
import type { PostgresSettings, RuntimeSettings } from './env'

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
  /**
   * The store of the sessions of the callers.
   *
   * The runtime exposes it so that a caller of the runtime — a test, a
   * benchmark — can create the session of the caller it authenticates,
   * whatever the backend of the store is.
   */
  sessions: SessionStore
  /** The exchanges with the upstreams. */
  exchanges: HttpExchangeService
  /** The websockets of the gateway. */
  websockets: WebSocketService
  /** True while the gateway is draining. */
  isDraining: () => boolean
  /** Stops the admission of new work. */
  setDraining: (draining: boolean) => void
  /** Drains the gateway and closes everything it owns. */
  drain: (reason: string) => Promise<void>
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

/**
 * A connection to the server whose state the replicas share.
 *
 * The scheme of the url picks the backend: a Redis server and a Postgres
 * server hold the same three things, and a deployment measures them side by
 * side (see `docs/capacity.md`).
 */
type SharedStateConnection =
  | { kind: 'redis'; client: SharedStateClient }
  | { kind: 'postgres'; client: PostgresClient }

/** The options of a connection to the server whose state the replicas share. */
interface SharedStateConnectionOptions {
  /** The url of the server; undefined when the state stays in the process. */
  url?: string
  /** The authority that signs the certificate of the server. */
  tlsCa?: string
  /** The name of the master, when the server is a Redis server behind sentinel. */
  sentinelMaster?: string
  /** The settings of the pool of the connections of a Postgres server. */
  postgres: PostgresSettings
  /** Called when the server cannot be reached. */
  onError: (error: unknown) => void
}

/**
 * Opens a connection to the server whose state the replicas share.
 *
 * The scheme of the url picks the backend. A url that names no server
 * returns nothing: the state stays in the memory of the process, which a
 * production deployment refuses.
 */
async function connectSharedState(
  options: SharedStateConnectionOptions
): Promise<SharedStateConnection | undefined> {
  const { url } = options
  if (isRedisUrl(url)) {
    return {
      kind: 'redis',
      client: withRetries(
        createRedisClient({
          url: url!,
          tlsCa: options.tlsCa,
          sentinelMaster: options.sentinelMaster,
          onError: options.onError,
        })
      ),
    }
  }
  if (isPostgresUrl(url)) {
    const client = createPostgresClient({
      url: url!,
      tlsCa: options.tlsCa,
      poolMax: options.postgres.poolMax,
      connectionTimeoutMs: options.postgres.connectionTimeoutMs,
      statementTimeoutMs: options.postgres.statementTimeoutMs,
      synchronousCommit: options.postgres.synchronousCommit,
      onError: options.onError,
    })
    if (options.postgres.autoMigrate) {
      // The schema is built by the client itself, every time the
      // connection is established: the statements are idempotent and a
      // gateway that starts while the database is down builds the schema
      // when the database answers.
      client.onConnect = async () => {
        await ensureSchema(client)
      }
    }
    return { kind: 'postgres', client: withPostgresRetries(client) }
  }
  return undefined
}

/**
 * Builds a limiter of a scope.
 *
 * The window lives in the server whose state the replicas share when there
 * is one, and in the memory of the process otherwise.
 *
 * A limiter whose windows live in the shared state is wrapped in a
 * [FallbackRateLimiter](../domains/rate-limiting/fallback.ts): when the
 * shared state cannot be reached, the deployment decides what happens to
 * the request — everything is allowed, the request is counted in the
 * process, or the request is refused. The default is to count it in the
 * process, so the protection against a flood survives the outage of the
 * shared state.
 */
function createLimiter(options: {
  max: number
  windowMs: number
  keyPrefix: string
  scope: string
  connection: SharedStateConnection | undefined
  fallback: RateLimitFallbackMode
  onError: (error: unknown) => void
  onFallback: (scope: string) => void
  onRecovered: (scope: string) => void
}): RequestLimiter {
  const {
    max,
    windowMs,
    keyPrefix,
    scope,
    connection,
    fallback,
    onError,
    onFallback,
    onRecovered,
  } = options
  if (connection?.kind === 'redis') {
    return new FallbackRateLimiter({
      shared: new RedisRateLimiter({
        max,
        windowMs,
        client: connection.client,
        keyPrefix,
        onError,
      }),
      mode: fallback,
      scope,
      onFallback,
      onRecovered: () => onRecovered(scope),
    })
  }
  if (connection?.kind === 'postgres') {
    return new FallbackRateLimiter({
      shared: new PostgresRateLimiter({
        max,
        windowMs,
        client: connection.client,
        keyPrefix,
        onError,
      }),
      mode: fallback,
      scope,
      onFallback,
      onRecovered: () => onRecovered(scope),
    })
  }
  return new MemoryRateLimiter({ max, windowMs })
}

/**
 * The options of the runtime.
 *
 * The sink of the log is an option and not a variable of the environment:
 * the tests read the lines the gateway writes, and a deployment writes
 * them to the standard output.
 */
export interface RuntimeOptions {
  /** The sink of the lines of the log; overridable for the tests. */
  logSink?: (line: string) => void
}

export async function createRuntime(
  settings: RuntimeSettings,
  options: RuntimeOptions = {}
): Promise<GatewayRuntime> {
  const logger = createLogger({
    level: settings.observability.logLevel,
    bindings: { service: 'shuttle' },
    write: options.logSink,
  })
  const observer = new MetricsStore()

  // The limiter of the shared state fails open when the deployment accepts
  // it: the protection against a flood is gone for as long as the server
  // is down. It is a permissive setting, and a permissive setting that
  // nobody read is a hole nobody knows about.
  if (settings.limits.fallback === 'open') {
    logger.warn('the limits are not enforced while the shared state is down', {
      hint: 'SHUTTLE_RATE_LIMIT_FALLBACK=local counts the requests in the window of the process, so the flood is bounded by the number of the replicas',
    })
  }

  // The signature of the identity is asymmetric: the gateway holds the
  // private key and the upstreams hold the public one, so an upstream that
  // can verify an identity cannot mint one. A deployment that has no key
  // signs with a key of its own process: the identity is signed with the
  // format of the release, but no upstream can verify it. A production
  // deployment is refused without a key before it reaches this point.
  if (!settings.identity.signingKey) {
    logger.warn('the key of the identity signature is generated for this process', {
      hint: 'run `bun run identity:key` and set SHUTTLE_IDENTITY_SIGNING_KEY: the upstreams verify the identity with the public key of the deployment, and a key of one process is not shared by the replicas',
    })
  }

  const config = new ConfigurationStore({
    source: settings.configPath,
    defaultMaxBodyBytes: settings.limits.maxBodyBytes,
    defaultUpstreamAttemptMs: settings.limits.upstreamAttemptMs,
    defaultReplayMaxBytes: settings.limits.replayMaxBytes,
    defaultAccessStaleGraceMs: settings.access.staleGraceMs,
    trustedProxies: settings.network.trustedProxies,
    // The policy that is running is written in the log: the route table
    // and the environment are large, and an operator has to be able to see
    // what the gateway does without reading the two.
    onPublished: (snapshot) => logActiveConfiguration(logger, snapshot),
  })

  // The failure of the shared state is reported once per outage.
  const onSharedStateError = (error: unknown): void => {
    logger.warn('the shared state is not reachable', { error })
    observer.recordSharedStateError()
  }

  // The store of the sessions. The scheme of the url selects the backend,
  // so the infrastructure only has to provide a single value.
  const sessionConnection = await connectSharedState({
    url: settings.session.url,
    tlsCa: settings.session.tlsCa,
    sentinelMaster: settings.session.sentinelMaster,
    postgres: settings.session.postgres,
    onError: onSharedStateError,
  })

  // The state the replicas share: the rate limits and the cached decisions.
  // It lives in a server when one is configured, and in the memory of the
  // process otherwise.
  //
  // A deployment that names the same server twice gets **one** connection
  // and not two: a Postgres server has a low limit of connections, and the
  // pool of the sessions and the pool of the shared state would double it.
  const sameServer =
    settings.sharedState.url !== undefined &&
    settings.sharedState.url === settings.session.url &&
    (settings.sharedState.tlsCa ?? undefined) === (settings.session.tlsCa ?? undefined)
  const sharedConnection = sameServer
    ? sessionConnection
    : await connectSharedState({
        url: settings.sharedState.url,
        tlsCa: settings.sharedState.tlsCa,
        sentinelMaster: settings.sharedState.sentinelMaster,
        postgres: settings.sharedState.postgres,
        onError: onSharedStateError,
      })
  const sessions: SessionStore =
    sessionConnection?.kind === 'redis'
      ? new RedisSessionStore({
          client: sessionConnection.client,
          keyPrefix: settings.session.keyPrefix,
          ttlMs: settings.session.ttlMs,
          maxAgeMs: settings.session.maxAgeMs,
          touchIntervalMs: settings.session.touchIntervalMs,
        })
      : sessionConnection?.kind === 'postgres'
        ? new PostgresSessionStore({
            client: sessionConnection.client,
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
    requiredTokenClaims: settings.oidc.requiredTokenClaims,
    rejectNonceTokens: settings.oidc.rejectNonceTokens,
    // The bound of the lifetime of a bearer token: it is what turns the
    // removal of a caller from the provider into a bounded delay.
    maxTokenAgeMs: settings.oidc.maxTokenAgeMs,
    allowInsecureIssuer: settings.oidc.allowInsecureIssuer,
    // Outside a production deployment a public client is allowed: the
    // development stack uses one. A production deployment has to name the
    // secret of the client or to allow the public client explicitly, which
    // the environment validates.
    allowPublicClient: settings.oidc.allowPublicClient || !settings.production,
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
  const decisionCache: DecisionCache =
    sharedConnection?.kind === 'redis'
      ? new RedisDecisionCache({
          client: sharedConnection.client,
          keyPrefix: settings.sharedState.keyPrefix,
          onError: onSharedStateError,
        })
      : sharedConnection?.kind === 'postgres'
        ? new PostgresDecisionCache({
            client: sharedConnection.client,
            keyPrefix: settings.sharedState.keyPrefix,
            onError: onSharedStateError,
          })
        : new MemoryDecisionCache()
  const access = new AccessClient({
    baseUrl: settings.access.baseUrl,
    token: settings.access.token,
    timeoutMs: settings.access.timeoutMs,
    cacheTtlMs: settings.access.cacheTtlMs,
    staleGraceMs: settings.access.staleGraceMs,
    // The breaker of the service: a service that failed recently is not
    // called, and the requests that need it are answered at once instead
    // of waiting for a call that is going to fail. The breaker only
    // refuses, so it cannot let a caller in that the service would not
    // have let in.
    breaker: {
      failures: settings.access.breakerFailures,
      cooldownMs: settings.access.breakerCooldownMs,
    },
    transport: new FetchAccessTransport(),
    cache: decisionCache,
    onError: (error) => logger.warn('the access service request failed', { error }),
    // The service is not called at all while the breaker is open. The
    // operator has to see it: the metric of the unavailability counts the
    // refusals, and this one counts the calls that were not made.
    onBreakerOpen: () =>
      logger.warn('the access service is not called any more', {
        reason: 'it failed recently',
        cooldownMs: settings.access.breakerCooldownMs,
      }),
    onBreakerRecovery: () => logger.info('the access service answered again'),
    // The latency of the service is published: it is a dependency of its
    // own on the path of every request of a workspace.
    onDecision: (routeId, durationMs) => observer.recordAccess(routeId, durationMs),
    // A decision that was served while the service was down is published:
    // it is a degradation of the deployment and the operator has to see
    // it.
    onStale: (routeId, ageMs) => observer.recordAccessStale(routeId, ageMs),
  })

  // The limiters. A deployment with more than one replica shares its
  // windows, so the limit of the deployment is the configured limit.
  //
  // The limiter of a scope that lives in the shared state degrades when the
  // shared state cannot be reached: the request is counted in the process
  // instead, and the degradation is published. The flood is bounded by the
  // number of the replicas instead of being unbounded.
  //
  // The degradation is written in the log **once**: a line for every
  // request that was counted in the process would be noise, and the metric
  // counts them.
  const degradedScopes = new Set<string>()
  const onLimiterFallback = (scope: string): void => {
    observer.recordRateLimitFallback(scope)
    if (degradedScopes.has(scope)) return
    degradedScopes.add(scope)
    logger.warn('the limits are counted in the window of the process', {
      scope,
      mode: settings.limits.fallback,
      hint: 'the shared state of the limits is not reachable: the budget of a caller is spent per replica and not per deployment',
    })
  }
  const onLimiterRecovered = (scope: string): void => {
    if (!degradedScopes.delete(scope)) return
    logger.info('the limits are counted in the shared state again', { scope })
  }
  const rateLimiter = createLimiter({
    max: settings.limits.route.max,
    windowMs: settings.limits.route.windowMs,
    keyPrefix: settings.sharedState.keyPrefix,
    scope: 'route',
    connection: sharedConnection,
    fallback: settings.limits.fallback,
    onError: onSharedStateError,
    onFallback: onLimiterFallback,
    onRecovered: onLimiterRecovered,
  })
  const globalRateLimiter = createLimiter({
    max: settings.limits.global.max,
    windowMs: settings.limits.global.windowMs,
    keyPrefix: `${settings.sharedState.keyPrefix}:global`,
    scope: 'global',
    connection: sharedConnection,
    fallback: settings.limits.fallback,
    onError: onSharedStateError,
    onFallback: onLimiterFallback,
    onRecovered: onLimiterRecovered,
  })
  // The budget of an authenticated caller on one route. It is keyed by the
  // subject of the caller, so one tenant cannot spend the budget of the
  // others behind the same address.
  const principalRateLimiter = createLimiter({
    max: settings.limits.principal.max,
    windowMs: settings.limits.principal.windowMs,
    keyPrefix: `${settings.sharedState.keyPrefix}:principal`,
    scope: 'principal',
    connection: sharedConnection,
    fallback: settings.limits.fallback,
    onError: onSharedStateError,
    onFallback: onLimiterFallback,
    onRecovered: onLimiterRecovered,
  })
  // The budget of the whole deployment. The scopes that are keyed by an
  // address cannot bound a flood that spreads over many addresses; this one
  // can.
  const totalRateLimiter = createLimiter({
    max: settings.limits.total.max,
    windowMs: settings.limits.total.windowMs,
    keyPrefix: `${settings.sharedState.keyPrefix}:total`,
    scope: 'total',
    connection: sharedConnection,
    fallback: settings.limits.fallback,
    onError: onSharedStateError,
    onFallback: onLimiterFallback,
    onRecovered: onLimiterRecovered,
  })
  const loginRateLimiter = createLimiter({
    max: settings.limits.login.max,
    windowMs: settings.limits.login.windowMs,
    keyPrefix: `${settings.sharedState.keyPrefix}:login`,
    scope: 'login',
    connection: sharedConnection,
    fallback: settings.limits.fallback,
    onError: onSharedStateError,
    onFallback: onLimiterFallback,
    onRecovered: onLimiterRecovered,
  })

  // The health of the upstreams.
  //
  // The breaker is passive and it is per process: it learns from the
  // failures this replica observes and it never probes an upstream. An
  // upstream that failed recently is moved to the end of the list, so a
  // request that may not be sent twice still reaches an upstream that
  // answered recently (§11.4 of the specification).
  const breaker = new UpstreamBreaker({
    failures: settings.limits.upstreamBreakerFailures,
    cooldownMs: settings.limits.upstreamBreakerCooldownMs,
    onFailure: (url) => {
      observer.recordUpstreamFailure()
      logger.debug('the upstream failed', { upstream: url })
    },
    onOpen: (url) => {
      logger.warn('the upstream is skipped', {
        upstream: url,
        hint: 'the upstream failed recently; it is tried again after the cooldown',
      })
    },
    onRecovery: (url) => {
      logger.info('the upstream answered again', { upstream: url })
    },
  })

  const exchanges = new HttpExchangeService({
    transport: new BunHttpTransport({ tls: settings.upstreamTls }),
    maxConcurrent: settings.resources.maxConcurrentRequests,
    breaker,
    onUpstreamSkipped: () => observer.recordUpstreamSkipped(),
  })

  // The admission of the requests. It bounds the requests that are inside
  // the gateway at the same time, and it covers the phase that comes
  // before the exchange: the limits, the session and the decision of the
  // access service. A request that waits for a hanging access service
  // would never reach the cap of the exchanges.
  const admission = new AdmissionController({
    max: settings.resources.maxPendingRequests,
  })

  // The websockets. The domain owns the reservations, the handshake and the
  // bridge; the platform owns the sockets.
  const reservations = new ReservationManager({
    maxConnections: settings.websockets.maxConnections,
  })
  const websockets = new WebSocketService({
    upstream: new WsUpstreamHandshake({ tls: settings.upstreamTls }),
    reservations,
    settings: {
      maxConnections: settings.websockets.maxConnections,
      maxBufferedBytes: settings.websockets.maxBufferedBytes,
      maxBufferedMessages: settings.websockets.maxBufferedMessages,
      backpressureLimitBytes: settings.websockets.backpressureLimitBytes,
      pingIntervalMs: settings.websockets.pingIntervalMs,
      pongTimeoutMs: settings.websockets.pongTimeoutMs,
      handshakeTimeoutMs: settings.websockets.handshakeTimeoutMs,
      revalidateIntervalMs: settings.websockets.revalidateIntervalMs,
    },
    logger,
    observer,
  })

  // The address of the peer of a request is known by the listener, which is
  // built after the application: the holder is filled in below.
  const peer = { address: (_request: Request) => '0.0.0.0' }
  // The gateway stops accepting new work when it drains.
  const state = { draining: false }

  const dependencies: GatewayDependencies = {
    version: VERSION,
    config,
    auth,
    access,
    exchanges,
    // The admission bounds the requests that are inside the gateway at
    // the same time. It covers the phase that waits for a dependency,
    // which the cap of the exchanges does not reach.
    admission,
    rateLimiter,
    globalRateLimiter,
    principalRateLimiter,
    totalRateLimiter,
    loginRateLimiter,
    // The key of the signature of the identity: the private key of the
    // deployment when it has one, and a key of this process otherwise.
    identityKey: settings.identity.signingKey
      ? asymmetricIdentityKey(settings.identity.signingKey)
      : ephemeralIdentityKey(),
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
    isDraining: () => state.draining,
    websockets,
  }

  const app = createGatewayApp(dependencies)
  const listener = startListener({
    app: createGatewayHandler(app),
    host: settings.network.host,
    port: settings.network.port,
    websocket: {
      handlers: createWebSocketHandlers(),
      maxPayloadLength: settings.websockets.maxPayloadBytes,
      backpressureLimitBytes: settings.websockets.backpressureLimitBytes,
      idleTimeoutSeconds: settings.websockets.idleTimeoutSeconds,
    },
    onError: (error) => logger.error('the listener reported an error', { error }),
  })
  peer.address = listener.peerAddress

  const closeResources = async (): Promise<void> => {
    await access.close()
    await sharedConnection?.client.close()
    await sessionConnection?.client.close()
  }

  return {
    settings,
    logger,
    observer,
    config,
    auth,
    exchanges,
    /**
     * The store of the sessions.
     *
     * It is exposed so that a caller of the runtime can create the
     * session of the caller it authenticates, whatever the backend of the
     * store is.
     */
    sessions,
    /** The gateway stops accepting new work when it drains. */
    setDraining: (draining: boolean) => {
      state.draining = draining
    },
    websockets,
    isDraining: () => state.draining,
    listener,
    drain: async (reason: string) => {
      await drainRuntime(
        {
          logger,
          timeoutMs: settings.shutdownTimeoutMs,
          stopListener: (force) => listener.stop(force),
          closeWebsockets: () => websockets.closeAll(),
          abortExchanges: () => exchanges.abortAll(),
          closeResources,
          setDraining: (draining) => {
            state.draining = draining
          },
        },
        reason
      )
    },
    close: closeResources,
  }
}
