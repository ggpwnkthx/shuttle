/**
 * The environment of the gateway.
 *
 * The environment is read once, at the start of the process, and it is
 * validated as a whole: a value that cannot be understood stops the
 * gateway, because a setting that looks active but is not is a security
 * hole. The only exception is the level of the log, which falls back to
 * `info`: a typo in the level of a log must not keep a deployment down.
 *
 * The names of the variables never leave this module: the rest of the
 * gateway receives the settings it needs, not the environment.
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { RateLimitFallbackMode } from '../domains/rate-limiting'
import { isSharedStateUrl } from './shared-state'

/** The level of the log. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** The settings of the identity provider. */
export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes: string[]
  rolesClaim: string
  /** The claims a bearer token has to carry. */
  requiredTokenClaims: string[]
  /**
   * Refuses a bearer token that carries a nonce.
   *
   * The browser flow always asks for a nonce, so an id token of this client
   * always carries one and an access token never does. A provider whose
   * access tokens carry a nonce anyway turns the check off.
   */
  rejectNonceTokens: boolean
  /**
   * The longest lifetime a bearer token may have, in milliseconds.
   *
   * The lifetime is the time between the moment the token was issued and
   * the moment it expires. Zero disables the bound. The bound is what turns
   * the removal of a caller from the identity provider into a delay that is
   * bounded by the deployment.
   */
  maxTokenAgeMs: number
  audience?: string
  /** Allows a provider that is not served over https. */
  allowInsecureIssuer: boolean
  /** Allows a client without a secret. */
  allowPublicClient: boolean
}

/** The settings of the access service. */
export interface AccessSettings {
  baseUrl: string
  token?: string
  timeoutMs: number
  cacheTtlMs: number
  /** The grace of an outage of the service, in milliseconds. */
  staleGraceMs: number
  allowAnonymous: boolean
  /**
   * The number of failures of the service before it is not called any
   * more, and how long it is not called.
   *
   * The breaker only refuses: it never lets a caller in, so it cannot be
   * a hole. Zero disables it.
   */
  breakerFailures: number
  breakerCooldownMs: number
}

/** The settings of the signature of the identity. */
export interface IdentitySettings {
  /**
   * The private key that signs the identity of a request, as a PEM.
   *
   * The key is an elliptic curve key on the curve P-256, and the signature
   * is an `ES256` one. The upstreams are given the **public** key: they
   * verify the identity of a request and they cannot mint one.
   *
   * A deployment that does not set it signs with a key that is generated
   * for the process: the format of the signature is the same, but no
   * upstream can verify the identity, and the key is neither shared by the
   * replicas nor kept across a restart. A production deployment has to set
   * it: the key belongs to the deployment and it is the same on every
   * replica.
   */
  signingKey?: string
}

/** The settings of the sessions. */
export interface SessionSettings {
  url: string
  keyPrefix: string
  ttlMs: number
  /** The maximum age of a session, counted from its creation. 0 is unlimited. */
  maxAgeMs: number
  touchIntervalMs: number
  maxSessions: number
  tlsCa?: string
  /**
   * The name of the master, when the server is behind sentinel.
   *
   * The hosts of the url are then the sentinels, and the master and the
   * replicas are discovered from them.
   */
  sentinelMaster?: string
  /** The secret that signs the state cookie and that derives the signature key. */
  secret: string
  /** The settings of the pool of the connections, when the server is a Postgres server. */
  postgres: PostgresSettings
}

/** The settings of the pool of the connections of a Postgres server. */
export interface PostgresSettings {
  /** The number of connections of the pool of a replica. */
  poolMax: number
  /** How long the client waits for a connection of the pool. */
  connectionTimeoutMs: number
  /** How long a statement of the gateway may run, in milliseconds. */
  statementTimeoutMs: number
  /**
   * Whether the server waits for the disk before it answers.
   *
   * The state of the shared state is a protection and not a ledger: a
   * counter that is lost when the server crashes costs a caller a few
   * requests of its budget, and a session that is lost costs a caller its
   * login. `off` is the same guarantee a Redis server gives without its
   * append only file, and it is the default for that reason. `on` waits
   * for the disk on every transaction.
   */
  synchronousCommit: 'on' | 'off'
  /**
   * Builds the schema of the shared state when the client connects.
   *
   * The statements are idempotent, so a deployment whose replicas start
   * at the same time does not race with itself. A deployment that applies
   * its own migrations says no here.
   */
  autoMigrate: boolean
}

/** The settings of the state the replicas share. */
export interface SharedStateSettings {
  url?: string
  keyPrefix: string
  tlsCa?: string
  /** The name of the master, when the server is behind sentinel. */
  sentinelMaster?: string
  /** The settings of the pool of the connections, when the server is a Postgres server. */
  postgres: PostgresSettings
}

/** The settings of the listener and of the network. */
export interface NetworkSettings {
  host: string
  port: number
  /** The protocol the clients use towards the gateway. */
  externalProto: 'http' | 'https'
  /** The extra ranges whose forwarding headers are trusted. */
  trustedProxies: string[]
}

/** The settings of the browser. */
/**
 * The TLS of the connections to the upstreams.
 *
 * The gateway presents the certificate of the deployment to the upstreams
 * that ask for one, and it verifies the certificate of the upstream with the
 * authority of the deployment.
 */
export interface UpstreamTlsSettings {
  /** The authority that signs the certificate of the upstream, in PEM. */
  ca?: string
  /** The certificate of the gateway, in PEM. */
  cert?: string
  /** The private key of the certificate of the gateway, in PEM. */
  key?: string
}

export interface BrowserSettings {
  /** The `Secure` attribute of the cookies. */
  cookieSecure: boolean
  /** The origins that are allowed in addition to the origin of the gateway. */
  allowedOrigins: string[]
  /** Refuse the navigations from another site as well. */
  csrfStrict: boolean
}

/** The settings of the limiters. */
export interface LimitSettings {
  maxBodyBytes: number
  /** The budget of one attempt to an upstream, when the route names several. */
  upstreamAttemptMs: number
  /** The size of a body that may be sent again to a second upstream. */
  replayMaxBytes: number
  /**
   * The number of consecutive failures before an upstream is skipped.
   *
   * The breaker is passive: it learns from the failures the gateway
   * observes and it never probes an upstream. An upstream that failed
   * recently is moved to the end of the list, so a request that may not be
   * sent twice still reaches an upstream that answered recently.
   *
   * Zero disables the breaker: the order of the list is always the order of
   * the file.
   */
  upstreamBreakerFailures: number
  /**
   * How long an upstream is skipped, in milliseconds.
   *
   * The upstream is tried again when the cooldown is over, even when it
   * failed in the meantime: the breaker never removes an upstream.
   */
  upstreamBreakerCooldownMs: number
  route: { max: number; windowMs: number }
  global: { max: number; windowMs: number }
  /**
   * The budget of an authenticated caller on one route.
   *
   * The other scopes are keyed by the address of the caller, so a caller
   * behind a proxy that serves many users shares one budget with all of
   * them. This scope is keyed by the subject of the caller, so one noisy
   * tenant cannot spend the budget of the others.
   */
  principal: { max: number; windowMs: number }
  /**
   * The budget of the whole deployment.
   *
   * The scopes that are keyed by an address cannot bound a flood that
   * spreads over many addresses. This scope can: every request of the
   * deployment is counted in the same window.
   */
  total: { max: number; windowMs: number }
  login: { max: number; windowMs: number }
  /**
   * What happens to a request when the state the replicas share cannot be
   * reached.
   *
   * The limiter of a scope that lives in the shared state cannot count the
   * request in the window of the deployment while the server is down.
   *
   * - `local`: the request is counted in the window of the **process**. The
   *   flood is bounded by the number of the replicas instead of being
   *   unbounded.
   * - `open`: every request is allowed. The behaviour of the releases
   *   before this one.
   * - `closed`: every request is refused.
   */
  fallback: RateLimitFallbackMode
}

/**
 * The settings of the resources of the process.
 */
export interface ResourceSettings {
  /**
   * The maximum number of requests that may be handled at the same time.
   *
   * A client that opens a request and never sends its body holds a
   * connection until the idle budget of the upload runs out. The cap is
   * the bound of that. A value of zero means "no limit".
   */
  maxConcurrentRequests: number
  /**
   * The maximum number of requests that may be inside the gateway at the
   * same time.
   *
   * The cap above bounds the exchanges with the upstreams. This one
   * bounds the whole pipeline, and it covers the phase that comes before
   * the exchange: the limits, the session and the decision of the access
   * service. A request that waits for a hanging access service holds the
   * resources of the process for the whole budget of the call, and the
   * cap of the exchanges never sees it.
   *
   * A request that does not fit is refused at once with `503
   * gateway_overloaded`: a refusal is faster than a wait.
   *
   * A value of zero means "no limit".
   */
  maxPendingRequests: number
}

/** The settings of the websockets. */
export interface WebSocketSettings {
  maxConnections: number
  maxPayloadBytes: number
  maxBufferedBytes: number
  maxBufferedMessages: number
  backpressureLimitBytes: number
  pingIntervalMs: number
  pongTimeoutMs: number
  idleTimeoutSeconds: number
  handshakeTimeoutMs: number
  /**
   * How often an open connection is revalidated, in milliseconds.
   *
   * A value of zero disables the revalidation: the connection is then
   * authorized when it is opened and never again.
   */
  revalidateIntervalMs: number
}

/** The settings of the observation. */
export interface ObservabilitySettings {
  logLevel: LogLevel
  /** The bearer token that guards the metrics endpoint. */
  metricsToken?: string
}

/** Everything the gateway needs to start. */
export interface RuntimeSettings {
  /** True when `NODE_ENV=production`. */
  production: boolean
  /** The file the route table is read from. */
  configPath: string
  network: NetworkSettings
  oidc: OidcSettings
  access: AccessSettings
  session: SessionSettings
  sharedState: SharedStateSettings
  browser: BrowserSettings
  /** The settings of the signature of the identity. */
  identity: IdentitySettings
  /** The TLS of the connections to the upstreams. */
  upstreamTls: UpstreamTlsSettings
  limits: LimitSettings
  /** The bounds of the resources of the process. */
  resources: ResourceSettings
  websockets: WebSocketSettings
  observability: ObservabilitySettings
  /** The deadline of the drain on a termination signal. */
  shutdownTimeoutMs: number
}

/** The issuer of the development fixture. */
export const DEVELOPMENT_OIDC_ISSUER = 'http://localhost:5556/dex'

/** The address of the development fixture of the access service. */
export const DEVELOPMENT_ACCESS_URL = 'http://localhost:8090'

/** An integer of the environment. */
function intEnv(defaultValue: number, options: { min?: number; max?: number } = {}) {
  let schema = z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? Number.NaN : value),
    z.coerce.number().int('a whole number is expected')
  )
  if (options.min !== undefined) {
    const min = options.min
    schema = schema.refine((value) => value >= min, {
      message: `the value must be at least ${min}`,
    })
  }
  if (options.max !== undefined) {
    const max = options.max
    schema = schema.refine((value) => value <= max, {
      message: `the value must be at most ${max}`,
    })
  }
  return schema.default(defaultValue)
}

/** A boolean of the environment. */
function boolEnv() {
  return z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional()
}

/** A list of the environment, separated by commas. */
function listEnv() {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
    .default([])
}

/** A certificate authority, given as PEM or as base64. */
function tlsCaEnv() {
  return z.string().optional()
}

/**
 * A PEM value, given directly or as base64.
 *
 * The secret stores hand out the certificates of a deployment in base64,
 * because a PEM in an environment variable is hard to read.
 */
function pemOf(pem: string | undefined, base64: string | undefined): string | undefined {
  if (pem) return pem
  if (!base64) return undefined
  try {
    return Buffer.from(base64, 'base64').toString('utf8')
  } catch {
    throw new Error('the value is not base64')
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),

  SHUTTLE_CONFIG: z.string().default('./config/routes.json'),
  SHUTTLE_GATEWAY_HOST: z.string().default('0.0.0.0'),
  SHUTTLE_GATEWAY_PORT: intEnv(8080, { max: 65_535 }),

  SHUTTLE_OIDC_ISSUER: z.string().optional(),
  SHUTTLE_OIDC_CLIENT_ID: z.string().optional(),
  SHUTTLE_OIDC_CLIENT_SECRET: z.string().optional(),
  SHUTTLE_OIDC_REDIRECT_URI: z.string().optional(),
  SHUTTLE_OIDC_SCOPES: listEnv(),
  SHUTTLE_OIDC_ROLES_CLAIM: z.string().default('roles'),
  /**
   * The claims a bearer token has to carry.
   *
   * The gateway validates the signature, the issuer, the audience, the
   * expiry and the subject of a bearer token, and nothing else: many
   * providers do not publish a claim that says the token is an access
   * token. A provider that does publish one is named here, and a token
   * that does not carry it is refused.
   */
  SHUTTLE_OIDC_REQUIRED_TOKEN_CLAIMS: listEnv(),
  /**
   * Refuses a bearer token that carries a nonce.
   *
   * The check is on by default: the id token of this client always carries
   * a nonce and an access token never does, and an id token travels through
   * the browser. A provider whose access tokens carry a nonce anyway turns
   * the check off explicitly.
   */
  SHUTTLE_OIDC_REJECT_NONCE_TOKEN: boolEnv(),
  /**
   * The longest lifetime a bearer token may have, in milliseconds.
   *
   * The lifetime is the time between the moment the token was issued and
   * the moment it expires: the bound is on the lifetime and not on the
   * validity that is left, so a long-lived token does not become
   * acceptable again when it is close to its expiry.
   *
   * The bound is what turns the removal of a caller from the identity
   * provider into a delay that is bounded by the deployment: the token of a
   * caller that was removed keeps working for at most this long.
   *
   * The default is a day: it refuses nothing that a provider of access
   * tokens issues in practice, and it refuses a token that was issued with
   * a lifetime of weeks. Zero disables the bound.
   */
  SHUTTLE_OIDC_MAX_TOKEN_AGE_MS: intEnv(86_400_000, { min: 0 }),
  SHUTTLE_OIDC_AUDIENCE: z.string().optional(),
  SHUTTLE_OIDC_ALLOW_INSECURE: boolEnv(),
  /**
   * Allows a client of the identity provider without a secret.
   *
   * The setting is the production validation of the deployment: without a
   * secret the client is public, and the provider accepts the code of the
   * browser without a proof that the caller is the gateway.
   */
  SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT: boolEnv(),

  SHUTTLE_ACCESS_URL: z.string().optional(),
  SHUTTLE_ACCESS_TOKEN: z.string().optional(),
  SHUTTLE_ACCESS_TIMEOUT_MS: intEnv(3_000, { min: 1 }),
  /**
   * The number of failures of the access service before it is not called
   * any more, in milliseconds of the cooldown that follows.
   *
   * The breaker only refuses: it never lets a caller in, so it cannot be
   * a hole. It is what keeps an outage of the service from making the
   * gateway slow: a request that would wait for a call that is going to
   * fail is answered at once instead.
   *
   * Zero disables the breaker: the service is called on every request and
   * a request waits for the whole budget of the call when the service does
   * not answer.
   */
  SHUTTLE_ACCESS_BREAKER_FAILURES: intEnv(5, { min: 0 }),
  SHUTTLE_ACCESS_BREAKER_COOLDOWN_MS: intEnv(5_000, { min: 0, max: 3_600_000 }),
  SHUTTLE_ACCESS_CACHE_TTL_MS: intEnv(5_000, { min: 0 }),
  /**
   * How long a decision of the access service may be served after the
   * service became unreachable, in milliseconds.
   *
   * Zero disables it: an unreachable service is an outage and the gateway
   * answers `503` to it, which is the answer that tells the operator that
   * the service is down. A value above zero keeps the traffic of the
   * deployment flowing while the service is down, at the price of a
   * revocation that is late by that much.
   */
  SHUTTLE_ACCESS_STALE_GRACE_MS: intEnv(0, { min: 0, max: 3_600_000 }),
  /**
   * Allows the gateway to call the access service without a token.
   *
   * The setting is the production validation of the deployment: the access
   * service refuses a call without a token, so a deployment that does not
   * allow it has to configure one.
   */
  SHUTTLE_ACCESS_ALLOW_ANONYMOUS: boolEnv(),

  SHUTTLE_SESSION_SECRET: z.string().optional(),
  SHUTTLE_SESSION_URL: z.string().default('memory://local'),
  SHUTTLE_SESSION_KEY_PREFIX: z.string().default('shuttle'),
  SHUTTLE_SESSION_TTL_MS: intEnv(28_800_000, { min: 1_000 }),
  SHUTTLE_SESSION_MAX_AGE_MS: intEnv(86_400_000, { min: 0 }),
  SHUTTLE_SESSION_TOUCH_INTERVAL_MS: intEnv(60_000, { min: 0 }),
  SHUTTLE_SESSION_MAX_SESSIONS: intEnv(5_000, { min: 1 }),
  /**
   * Allows a production deployment that keeps the state in the process.
   *
   * The state of a deployment has to be shared: a session that lives in the
   * memory of one replica is unknown to the others, and a limit that lives
   * in the memory of one replica is the limit of that replica and not the
   * limit of the deployment. A deployment that is a single node may say
   * explicitly that it accepts the in-process state.
   */
  SHUTTLE_ALLOW_MEMORY_STATE: boolEnv(),
  SHUTTLE_SESSION_TLS_CA: tlsCaEnv(),
  SHUTTLE_SESSION_TLS_CA_BASE64: tlsCaEnv(),

  /**
   * The private key that signs the identity of a request, as a PEM.
   *
   * The key is an elliptic curve key on the curve P-256. The gateway holds
   * the private key and the upstreams are given the public one, so an
   * upstream that verifies an identity cannot mint one. The script
   * `scripts/identity-key.ts` generates a pair.
   *
   * A production deployment has to set it: without it the key is generated
   * for the process, so no upstream can verify an identity and the
   * replicas do not share it.
   */
  SHUTTLE_IDENTITY_SIGNING_KEY: z.string().optional(),
  SHUTTLE_IDENTITY_SIGNING_KEY_BASE64: z.string().optional(),

  /**
   * The TLS of the connections to the upstreams.
   *
   * The authority that signs the certificate of the upstream, and the
   * certificate of the gateway with its private key for the upstreams that
   * ask for one. The certificate and the key belong together: a certificate
   * without a key is a setting that looks active but is not.
   */
  SHUTTLE_UPSTREAM_TLS_CA: z.string().optional(),
  SHUTTLE_UPSTREAM_TLS_CA_BASE64: z.string().optional(),
  SHUTTLE_UPSTREAM_TLS_CERT: z.string().optional(),
  SHUTTLE_UPSTREAM_TLS_CERT_BASE64: z.string().optional(),
  SHUTTLE_UPSTREAM_TLS_KEY: z.string().optional(),
  SHUTTLE_UPSTREAM_TLS_KEY_BASE64: z.string().optional(),

  SHUTTLE_SHARED_STATE_URL: z.string().optional(),
  SHUTTLE_SHARED_STATE_KEY_PREFIX: z.string().default('shuttle'),
  SHUTTLE_SHARED_STATE_TLS_CA: tlsCaEnv(),
  SHUTTLE_SHARED_STATE_TLS_CA_BASE64: tlsCaEnv(),

  /**
   * The number of connections of the pool of a replica, when the shared
   * state lives in a Postgres server.
   *
   * A Postgres server has a limit of connections and it is much lower than
   * the limit of a Redis server: a deployment with several replicas and a
   * pool per replica has to fit in it, or behind a pooler.
   */
  SHUTTLE_POSTGRES_POOL_MAX: intEnv(10, { min: 1, max: 1000 }),
  /** How long the client waits for a connection of the pool. */
  SHUTTLE_POSTGRES_CONNECTION_TIMEOUT_MS: intEnv(5_000, { min: 100 }),
  /** How long a statement of the gateway may run, in milliseconds. */
  SHUTTLE_POSTGRES_STATEMENT_TIMEOUT_MS: intEnv(5_000, { min: 100 }),
  /**
   * Whether the server waits for the disk before it answers.
   *
   * The state of the shared state is a protection and not a ledger: the
   * default is `off`, the same guarantee a Redis server gives without its
   * append only file. It is the difference between a millisecond and a
   * tenth of a millisecond on every transaction of the limiter.
   */
  SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT: z.enum(['on', 'off']).optional(),
  /**
   * Builds the schema of the shared state when the client connects.
   *
   * The statements are idempotent, so a deployment whose replicas start at
   * the same time does not race with itself. A production deployment that
   * applies its own migrations says no here.
   */
  SHUTTLE_POSTGRES_AUTO_MIGRATE: boolEnv(),

  /**
   * The name of the master, when the shared state is behind sentinel.
   *
   * The hosts of the urls are then the sentinels. The master and the
   * replicas are discovered from them, and a failover is transparent for
   * the gateway.
   */
  SHUTTLE_REDIS_SENTINEL_MASTER: z.string().optional(),

  SHUTTLE_COOKIE_SECURE: boolEnv(),
  SHUTTLE_LOG_LEVEL: z.string().optional(),
  SHUTTLE_METRICS_TOKEN: z.string().optional(),
  SHUTTLE_MAX_BODY_BYTES: intEnv(10_485_760, { min: 0 }),
  SHUTTLE_MAX_CONCURRENT_REQUESTS: intEnv(1_000, { min: 0 }),
  /**
   * The maximum number of requests that may be inside the gateway at the
   * same time.
   *
   * The cap above bounds the exchanges with the upstreams. This one
   * bounds the whole pipeline, including the phase that waits for a
   * dependency: the limits, the session and the decision of the access
   * service. A request that waits for a hanging access service would
   * never reach the cap above.
   */
  SHUTTLE_MAX_PENDING_REQUESTS: intEnv(1_000, { min: 0 }),
  /**
   * The budget of one attempt to an upstream, when the route names several.
   *
   * An attempt that has another upstream behind it is abandoned when it
   * does not answer in time, and the next upstream is tried. It applies
   * only to a request that may be sent twice.
   *
   * Zero disables it: the budget of the answer governs the exchange.
   */
  SHUTTLE_UPSTREAM_ATTEMPT_TIMEOUT_MS: intEnv(2_000, { min: 0 }),
  /**
   * The size of a body that may be sent again to a second upstream.
   *
   * A body that fits is held in memory, so that the request may be sent to
   * the next upstream when the first one fails. A body that does not fit
   * is streamed and the request is sent once.
   *
   * The memory of the gateway is bounded by this value and by the number of
   * exchanges that run at the same time.
   *
   * Zero disables it: every body is streamed.
   */
  SHUTTLE_REPLAY_MAX_BYTES: intEnv(65_536, { min: 0 }),
  /**
   * The number of consecutive failures before an upstream is skipped.
   *
   * The breaker is passive: it learns from the failures the gateway
   * observes and it never probes an upstream. An upstream that failed
   * recently is moved to the end of the list, so a request that may not be
   * sent twice — a `POST`, most of the traffic of an API — still reaches
   * an upstream that answered recently.
   *
   * Zero disables the breaker: the order of the list is always the order of
   * the file.
   */
  SHUTTLE_UPSTREAM_BREAKER_FAILURES: intEnv(3, { min: 0 }),
  /**
   * How long an upstream is skipped, in milliseconds.
   *
   * The upstream is tried again when the cooldown is over, even when it
   * failed in the meantime.
   */
  SHUTTLE_UPSTREAM_BREAKER_COOLDOWN_MS: intEnv(30_000, { min: 0 }),

  SHUTTLE_TRUSTED_PROXIES: listEnv(),
  SHUTTLE_EXTERNAL_PROTO: z.enum(['http', 'https']).default('http'),
  SHUTTLE_ALLOWED_ORIGINS: listEnv(),
  SHUTTLE_CSRF_STRICT: boolEnv(),

  SHUTTLE_RATE_LIMIT_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  SHUTTLE_RATE_LIMIT_GLOBAL_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_PRINCIPAL_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  SHUTTLE_RATE_LIMIT_TOTAL_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_TOTAL_WINDOW_MS: intEnv(1_000, { min: 100 }),
  /**
   * What happens to a request when the state the replicas share cannot be
   * reached.
   *
   * The limiter of a scope that lives in the shared state has no window to
   * count the request in while the server is down.
   *
   * - `local`: the request is counted in the window of the **process**, so
   *   the protection against a flood survives the outage of the shared
   *   state. The budget of a caller is spent a little faster than it
   *   should be, because the window of the process does not know about the
   *   requests the other replicas counted.
   * - `open`: every request is allowed. The behaviour of the releases
   *   before this one: a hiccup of the server is not an outage of the
   *   deployment, and the protection against a flood is gone for as long as
   *   the server is down.
   * - `closed`: every request is refused, with a `retry-after`.
   *
   * The default is `local`: the limiter is the only protection of the
   * gateway against a flood, and a protection that disappears with the
   * server is not one the deployment can rely on.
   */
  SHUTTLE_RATE_LIMIT_FALLBACK: z.enum(['open', 'local', 'closed']).default('local'),
  /**
   * Allows a production deployment with every rate limit disabled.
   *
   * The limiter is the only protection of the gateway against a flood, and
   * a deployment that turns it off has to say so explicitly: a setting that
   * looks active but is not is a security hole.
   */
  SHUTTLE_ALLOW_NO_RATE_LIMITS: boolEnv(),
  SHUTTLE_LOGIN_RATE_LIMIT_MAX: intEnv(30, { min: 0 }),
  SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS: intEnv(60_000, { min: 1_000 }),

  SHUTTLE_WS_MAX_CONNECTIONS: intEnv(1_000, { min: 0 }),
  SHUTTLE_WS_MAX_PAYLOAD_BYTES: intEnv(16_777_216, { min: 1 }),
  SHUTTLE_WS_MAX_BUFFERED_BYTES: intEnv(262_144, { min: 0 }),
  SHUTTLE_WS_MAX_BUFFERED_MESSAGES: intEnv(100, { min: 0 }),
  SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES: intEnv(1_048_576, { min: 1 }),
  SHUTTLE_WS_PING_INTERVAL_MS: intEnv(30_000, { min: 0 }),
  SHUTTLE_WS_PONG_TIMEOUT_MS: intEnv(90_000, { min: 0 }),
  SHUTTLE_WS_IDLE_TIMEOUT_SECONDS: intEnv(120, { min: 0 }),
  SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS: intEnv(10_000, { min: 100 }),
  SHUTTLE_WS_REVALIDATE_INTERVAL_MS: intEnv(60_000, { min: 0 }),

  SHUTTLE_SHUTDOWN_TIMEOUT_MS: intEnv(15_000, { min: 0 }),
})

/** The environment of the process. */
export type Env = Record<string, string | undefined>

/**
 * The level of the log.
 *
 * A value that is not a level falls back to `info`: the level of the log
 * must not be a reason to keep a deployment down.
 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent']
  return levels.includes(normalized as LogLevel) ? (normalized as LogLevel) : fallback
}

/**
 * Reads the environment.
 *
 * A value that cannot be understood stops the gateway: the message names
 * the variable, so the operator knows what to fix.
 */
export function readEnv(env: Env = process.env): RuntimeSettings {
  const result = EnvSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'the environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`the environment is invalid: ${problems}`)
  }
  const parsed = result.data
  const production = parsed.NODE_ENV === 'production'

  if (production && !parsed.SHUTTLE_SESSION_SECRET) {
    throw new Error(
      'SHUTTLE_SESSION_SECRET must be set in a production environment: it signs the state cookie of the login flow and it derives the key of the identity signature, and it has to be the same on every replica'
    )
  }
  if (production && !parsed.SHUTTLE_OIDC_ISSUER) {
    throw new Error(
      'SHUTTLE_OIDC_ISSUER must be set in a production environment: it names the identity provider the callers authenticate against'
    )
  }
  if (production && !parsed.SHUTTLE_OIDC_CLIENT_ID) {
    throw new Error(
      'SHUTTLE_OIDC_CLIENT_ID must be set in a production environment: it names the client the gateway registers with the identity provider'
    )
  }
  if (production && !parsed.SHUTTLE_OIDC_REDIRECT_URI) {
    throw new Error(
      'SHUTTLE_OIDC_REDIRECT_URI must be set in a production environment: it is the url the identity provider sends the browser back to, and it has to be the url the gateway is reached under'
    )
  }
  if (
    production &&
    !parsed.SHUTTLE_OIDC_CLIENT_SECRET &&
    !parsed.SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT
  ) {
    throw new Error(
      'SHUTTLE_OIDC_CLIENT_SECRET must be set in a production environment, or SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT=true when the identity provider accepts a public client'
    )
  }
  if (production && !parsed.SHUTTLE_ACCESS_URL) {
    throw new Error(
      'SHUTTLE_ACCESS_URL must be set in a production environment: it names the access service that decides which caller may use a workspace'
    )
  }
  if (production && !parsed.SHUTTLE_ACCESS_TOKEN && !parsed.SHUTTLE_ACCESS_ALLOW_ANONYMOUS) {
    throw new Error(
      'SHUTTLE_ACCESS_TOKEN must be set in a production environment, or SHUTTLE_ACCESS_ALLOW_ANONYMOUS=true when the access service authenticates the gateway by other means'
    )
  }
  // The signature of the identity is asymmetric in a production
  // deployment: the gateway holds the private key and the upstreams hold
  // the public one, so an upstream that verifies an identity cannot mint
  // one. Without the key the signature is symmetric, the upstreams hold
  // the secret that signs it, and the trust boundary is the network
  // instead of the key.
  if (
    production &&
    !parsed.SHUTTLE_IDENTITY_SIGNING_KEY &&
    !parsed.SHUTTLE_IDENTITY_SIGNING_KEY_BASE64
  ) {
    throw new Error(
      'SHUTTLE_IDENTITY_SIGNING_KEY must be set in a production environment: it is the private key that signs the identity of a request, and the upstreams are given the public one, so an upstream that verifies an identity cannot mint one. The script `bun run identity:key` generates a pair'
    )
  }
  if (
    production &&
    !parsed.SHUTTLE_ALLOW_NO_RATE_LIMITS &&
    parsed.SHUTTLE_RATE_LIMIT_MAX === 0 &&
    parsed.SHUTTLE_RATE_LIMIT_GLOBAL_MAX === 0 &&
    parsed.SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX === 0 &&
    parsed.SHUTTLE_RATE_LIMIT_TOTAL_MAX === 0
  ) {
    throw new Error(
      'at least one rate limit must be set in a production environment (SHUTTLE_RATE_LIMIT_MAX, SHUTTLE_RATE_LIMIT_GLOBAL_MAX, SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX or SHUTTLE_RATE_LIMIT_TOTAL_MAX), or SHUTTLE_ALLOW_NO_RATE_LIMITS=true when the deployment is protected by another layer'
    )
  }

  // The state the replicas share lives in the session server when that one
  // is a server whose state is shared: a deployment that shares its
  // sessions shares its limits and its cached decisions as well.
  const sharedStateUrl =
    parsed.SHUTTLE_SHARED_STATE_URL ??
    (isSharedStateUrl(parsed.SHUTTLE_SESSION_URL) ? parsed.SHUTTLE_SESSION_URL : undefined)

  // The state of a deployment has to be shared. A session that lives in the
  // memory of a replica is unknown to the other replicas, so the callers
  // are logged out at random; a limit that lives in the memory of a replica
  // is the limit of that replica and not the limit of the deployment, so a
  // flood is bounded by the number of the replicas.
  //
  // A deployment that is a single node may keep the state in the process,
  // but it has to say so explicitly: a setting that looks active but is not
  // is a security hole.
  if (production && !parsed.SHUTTLE_ALLOW_MEMORY_STATE) {
    if (!isSharedStateUrl(parsed.SHUTTLE_SESSION_URL)) {
      throw new Error(
        'SHUTTLE_SESSION_URL must name a Redis or a Postgres server in a production environment: the sessions of the callers have to be shared by the replicas, because a session that lives in the memory of one replica is unknown to the others, or SHUTTLE_ALLOW_MEMORY_STATE=true when the deployment is a single node that accepts it'
      )
    }
    if (!isSharedStateUrl(sharedStateUrl)) {
      throw new Error(
        'SHUTTLE_SHARED_STATE_URL must name a Redis or a Postgres server in a production environment: the rate limits and the cached decisions have to be shared by the replicas, or SHUTTLE_ALLOW_MEMORY_STATE=true when the deployment is a single node that accepts it'
      )
    }
  }

  const scopes =
    parsed.SHUTTLE_OIDC_SCOPES.length > 0
      ? parsed.SHUTTLE_OIDC_SCOPES
      : ['openid', 'profile', 'email', 'groups']

  // The settings of the pool of the connections of a Postgres server.
  const postgresSettings: PostgresSettings = {
    poolMax: parsed.SHUTTLE_POSTGRES_POOL_MAX,
    connectionTimeoutMs: parsed.SHUTTLE_POSTGRES_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: parsed.SHUTTLE_POSTGRES_STATEMENT_TIMEOUT_MS,
    synchronousCommit: parsed.SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT ?? 'off',
    // The schema is built by the gateway outside a production deployment:
    // a production deployment applies its own migrations, so a gateway
    // that is started with a read-only database account does not fail.
    autoMigrate: parsed.SHUTTLE_POSTGRES_AUTO_MIGRATE ?? !production,
  }

  // The TLS of the connections to the upstreams. The certificate of the
  // gateway and its private key belong together: a certificate without a
  // key is a setting that looks active but is not, and the upstreams that
  // ask for a client certificate would refuse every request.
  const upstreamCert = pemOf(
    parsed.SHUTTLE_UPSTREAM_TLS_CERT,
    parsed.SHUTTLE_UPSTREAM_TLS_CERT_BASE64
  )
  const upstreamKey = pemOf(parsed.SHUTTLE_UPSTREAM_TLS_KEY, parsed.SHUTTLE_UPSTREAM_TLS_KEY_BASE64)
  if (Boolean(upstreamCert) !== Boolean(upstreamKey)) {
    throw new Error(
      'SHUTTLE_UPSTREAM_TLS_CERT and SHUTTLE_UPSTREAM_TLS_KEY must be set together: the certificate of the gateway is useless without its private key, and a private key without a certificate identifies nothing'
    )
  }

  return {
    production,
    configPath: parsed.SHUTTLE_CONFIG,
    network: {
      host: parsed.SHUTTLE_GATEWAY_HOST,
      port: parsed.SHUTTLE_GATEWAY_PORT,
      externalProto: parsed.SHUTTLE_EXTERNAL_PROTO,
      trustedProxies: parsed.SHUTTLE_TRUSTED_PROXIES,
    },
    oidc: {
      issuer: parsed.SHUTTLE_OIDC_ISSUER ?? DEVELOPMENT_OIDC_ISSUER,
      clientId: parsed.SHUTTLE_OIDC_CLIENT_ID ?? 'shuttle',
      clientSecret: parsed.SHUTTLE_OIDC_CLIENT_SECRET,
      redirectUri:
        parsed.SHUTTLE_OIDC_REDIRECT_URI ??
        `http://localhost:${parsed.SHUTTLE_GATEWAY_PORT}/auth/callback`,
      scopes,
      rolesClaim: parsed.SHUTTLE_OIDC_ROLES_CLAIM,
      requiredTokenClaims: parsed.SHUTTLE_OIDC_REQUIRED_TOKEN_CLAIMS,
      // The check is on unless the deployment turns it off: a setting that
      // looks active but is not is a security hole.
      rejectNonceTokens: parsed.SHUTTLE_OIDC_REJECT_NONCE_TOKEN ?? true,
      // The bound is on by default: a token that outlives the bound keeps
      // a caller that was removed from the provider working for as long as
      // the provider gave the token. The default of the variable is a day.
      maxTokenAgeMs: parsed.SHUTTLE_OIDC_MAX_TOKEN_AGE_MS,
      audience: parsed.SHUTTLE_OIDC_AUDIENCE,
      // A provider that is not served over https is only allowed outside a
      // production environment: a deployment terminates TLS in front of it.
      allowInsecureIssuer: parsed.SHUTTLE_OIDC_ALLOW_INSECURE ?? !production,
      allowPublicClient: parsed.SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT ?? false,
    },
    access: {
      baseUrl: parsed.SHUTTLE_ACCESS_URL ?? DEVELOPMENT_ACCESS_URL,
      token: parsed.SHUTTLE_ACCESS_TOKEN,
      timeoutMs: parsed.SHUTTLE_ACCESS_TIMEOUT_MS,
      cacheTtlMs: parsed.SHUTTLE_ACCESS_CACHE_TTL_MS,
      staleGraceMs: parsed.SHUTTLE_ACCESS_STALE_GRACE_MS,
      allowAnonymous: parsed.SHUTTLE_ACCESS_ALLOW_ANONYMOUS ?? false,
      breakerFailures: parsed.SHUTTLE_ACCESS_BREAKER_FAILURES,
      breakerCooldownMs: parsed.SHUTTLE_ACCESS_BREAKER_COOLDOWN_MS,
    },
    session: {
      url: parsed.SHUTTLE_SESSION_URL,
      keyPrefix: parsed.SHUTTLE_SESSION_KEY_PREFIX,
      ttlMs: parsed.SHUTTLE_SESSION_TTL_MS,
      maxAgeMs: parsed.SHUTTLE_SESSION_MAX_AGE_MS,
      touchIntervalMs: parsed.SHUTTLE_SESSION_TOUCH_INTERVAL_MS,
      maxSessions: parsed.SHUTTLE_SESSION_MAX_SESSIONS,
      tlsCa: parsed.SHUTTLE_SESSION_TLS_CA ?? parsed.SHUTTLE_SESSION_TLS_CA_BASE64,
      sentinelMaster: parsed.SHUTTLE_REDIS_SENTINEL_MASTER,
      postgres: postgresSettings,
      // A secret that is generated per process is only valid on the replica
      // that generated it: the signatures of the identity are not verifiable
      // by the upstreams of the other replicas and every restart invalidates
      // the logins that are in flight.
      secret: parsed.SHUTTLE_SESSION_SECRET ?? randomBytes(32).toString('hex'),
    },
    sharedState: {
      url: sharedStateUrl,
      keyPrefix: parsed.SHUTTLE_SHARED_STATE_KEY_PREFIX,
      tlsCa:
        parsed.SHUTTLE_SHARED_STATE_TLS_CA ??
        parsed.SHUTTLE_SHARED_STATE_TLS_CA_BASE64 ??
        parsed.SHUTTLE_SESSION_TLS_CA ??
        parsed.SHUTTLE_SESSION_TLS_CA_BASE64,
      sentinelMaster: parsed.SHUTTLE_REDIS_SENTINEL_MASTER,
      postgres: postgresSettings,
    },
    browser: {
      cookieSecure: parsed.SHUTTLE_COOKIE_SECURE ?? production,
      allowedOrigins: parsed.SHUTTLE_ALLOWED_ORIGINS,
      csrfStrict: parsed.SHUTTLE_CSRF_STRICT ?? false,
    },
    identity: {
      // The key is a PEM, given directly or as base64: the secret stores
      // hand out the keys of a deployment in base64.
      signingKey: pemOf(
        parsed.SHUTTLE_IDENTITY_SIGNING_KEY,
        parsed.SHUTTLE_IDENTITY_SIGNING_KEY_BASE64
      ),
    },
    upstreamTls: {
      ca: pemOf(parsed.SHUTTLE_UPSTREAM_TLS_CA, parsed.SHUTTLE_UPSTREAM_TLS_CA_BASE64),
      cert: upstreamCert,
      key: upstreamKey,
    },
    limits: {
      maxBodyBytes: parsed.SHUTTLE_MAX_BODY_BYTES,
      upstreamAttemptMs: parsed.SHUTTLE_UPSTREAM_ATTEMPT_TIMEOUT_MS,
      replayMaxBytes: parsed.SHUTTLE_REPLAY_MAX_BYTES,
      upstreamBreakerFailures: parsed.SHUTTLE_UPSTREAM_BREAKER_FAILURES,
      upstreamBreakerCooldownMs: parsed.SHUTTLE_UPSTREAM_BREAKER_COOLDOWN_MS,
      // What happens to a request while the state the replicas share cannot
      // be reached.
      fallback: parsed.SHUTTLE_RATE_LIMIT_FALLBACK as RateLimitFallbackMode,
      route: { max: parsed.SHUTTLE_RATE_LIMIT_MAX, windowMs: parsed.SHUTTLE_RATE_LIMIT_WINDOW_MS },
      global: {
        max: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_MAX,
        windowMs: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS,
      },
      principal: {
        max: parsed.SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX,
        windowMs: parsed.SHUTTLE_RATE_LIMIT_PRINCIPAL_WINDOW_MS,
      },
      total: {
        max: parsed.SHUTTLE_RATE_LIMIT_TOTAL_MAX,
        windowMs: parsed.SHUTTLE_RATE_LIMIT_TOTAL_WINDOW_MS,
      },
      login: {
        max: parsed.SHUTTLE_LOGIN_RATE_LIMIT_MAX,
        windowMs: parsed.SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS,
      },
    },
    resources: {
      maxConcurrentRequests: parsed.SHUTTLE_MAX_CONCURRENT_REQUESTS,
      maxPendingRequests: parsed.SHUTTLE_MAX_PENDING_REQUESTS,
    },
    websockets: {
      maxConnections: parsed.SHUTTLE_WS_MAX_CONNECTIONS,
      maxPayloadBytes: parsed.SHUTTLE_WS_MAX_PAYLOAD_BYTES,
      maxBufferedBytes: parsed.SHUTTLE_WS_MAX_BUFFERED_BYTES,
      maxBufferedMessages: parsed.SHUTTLE_WS_MAX_BUFFERED_MESSAGES,
      backpressureLimitBytes: parsed.SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES,
      pingIntervalMs: parsed.SHUTTLE_WS_PING_INTERVAL_MS,
      pongTimeoutMs: parsed.SHUTTLE_WS_PONG_TIMEOUT_MS,
      idleTimeoutSeconds: parsed.SHUTTLE_WS_IDLE_TIMEOUT_SECONDS,
      handshakeTimeoutMs: parsed.SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS,
      revalidateIntervalMs: parsed.SHUTTLE_WS_REVALIDATE_INTERVAL_MS,
    },
    observability: {
      logLevel: parseLogLevel(parsed.SHUTTLE_LOG_LEVEL),
      metricsToken: parsed.SHUTTLE_METRICS_TOKEN,
    },
    shutdownTimeoutMs: parsed.SHUTTLE_SHUTDOWN_TIMEOUT_MS,
  }
}
