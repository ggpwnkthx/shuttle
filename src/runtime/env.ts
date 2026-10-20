import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { parseLogLevel } from '../log/logger'
import { isRedisUrl } from '../redis/client'
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
} from '../auth/session'
import type { RuntimeOptions, SessionRuntimeOptions } from './runtime'

export type Env = Record<string, string | undefined>

/**
 * The environment of the gateway.
 *
 * The schema is the single place where the environment is read. A value
 * that cannot be understood stops the gateway instead of falling back to a
 * default: the route table rejects a setting it does not implement, and the
 * environment does the same. A typo in `SHUTTLE_MAX_BODY_BYTES` would
 * otherwise remove the limit of the request bodies without a word.
 *
 * The log level is the one exception: a level that is not known is a
 * nuisance, not a hole, so it falls back to `info`.
 */

/** A number of the environment, with a fallback. */
function intEnv(fallback: number, options: { min?: number; max?: number } = {}) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : Number(value)),
    z
      .number()
      .int()
      .min(options.min ?? 0)
      .max(options.max ?? Number.MAX_SAFE_INTEGER)
      .optional()
      .default(fallback)
  )
}

/** A boolean of the environment. */
function optionalBoolEnv() {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === '') return undefined
      const normalized = String(value).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false
      return value
    },
    z.boolean().optional()
  )
}

/** A comma separated list of the environment. */
function listEnv() {
  return z.preprocess(
    (value) =>
      value === undefined
        ? undefined
        : String(value)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    z.array(z.string()).catch([])
  )
}

/** A base64 encoded value of the environment, for example a PEM certificate. */
function base64Env() {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === '') return undefined
      const raw = String(value).trim()
      const decoded = Buffer.from(raw, 'base64').toString('utf8')
      // `Buffer.from` never fails: it drops the characters it does not
      // understand. The value is compared with its own encoding, so a broken
      // base64 is reported instead of silently decoded into nothing.
      const canonical = Buffer.from(decoded).toString('base64').replace(/=+$/, '')
      if (canonical !== raw.replace(/\s+/g, '').replace(/=+$/, '')) {
        return value
      }
      return decoded
    },
    z.string().optional()
  )
}

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  SHUTTLE_CONFIG: z.string().catch('./config/routes.json'),
  SHUTTLE_GATEWAY_PORT: intEnv(8080, { max: 65_535 }),
  SHUTTLE_GATEWAY_HOST: z.string().catch('0.0.0.0'),

  /**
   * The issuer of the identity provider.
   *
   * There is no default: the value of the development environment points at
   * the fixture of the repository, a production deployment has to name its
   * own provider.
   */
  SHUTTLE_OIDC_ISSUER: z.string().optional(),
  SHUTTLE_OIDC_CLIENT_ID: z.string().optional(),
  SHUTTLE_OIDC_CLIENT_SECRET: z.string().optional(),
  SHUTTLE_OIDC_REDIRECT_URI: z.string().optional(),
  SHUTTLE_OIDC_SCOPES: listEnv(),
  SHUTTLE_OIDC_ROLES_CLAIM: z.string().catch('roles'),
  SHUTTLE_OIDC_AUDIENCE: z.string().optional(),
  SHUTTLE_OIDC_ALLOW_INSECURE: optionalBoolEnv(),
  /**
   * Allows a public client, a client without a secret.
   *
   * Only for a provider that accepts the public clients of the code flow
   * with PKCE. It is refused in production unless it is set explicitly.
   */
  SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT: optionalBoolEnv(),

  SHUTTLE_ACCESS_URL: z.string().optional(),
  SHUTTLE_ACCESS_TOKEN: z.string().optional(),
  SHUTTLE_ACCESS_TIMEOUT_MS: intEnv(3_000),
  SHUTTLE_ACCESS_CACHE_TTL_MS: intEnv(5_000),
  /**
   * Allows the gateway to ask the access service without a token.
   *
   * Only for a deployment where the access service is reachable over a
   * trusted network and authenticates the gateway by other means. It is
   * refused in production unless it is set explicitly.
   */
  SHUTTLE_ACCESS_ALLOW_ANONYMOUS: optionalBoolEnv(),

  SHUTTLE_SESSION_SECRET: z.string().optional(),
  SHUTTLE_SESSION_URL: z.string().catch('memory://local'),
  SHUTTLE_SESSION_KEY_PREFIX: z.string().catch('shuttle'),
  SHUTTLE_SESSION_TTL_MS: intEnv(DEFAULT_SESSION_TTL_MS),
  SHUTTLE_SESSION_TOUCH_INTERVAL_MS: intEnv(DEFAULT_SESSION_TOUCH_INTERVAL_MS),
  SHUTTLE_SESSION_MAX_SESSIONS: intEnv(DEFAULT_MAX_SESSIONS),
  SHUTTLE_SESSION_TLS_CA: z.string().optional(),
  SHUTTLE_SESSION_TLS_CA_BASE64: base64Env(),

  /**
   * Url of the server that holds the state the replicas share: the rate
   * limits and the cached access decisions.
   *
   * It defaults to the session store when that one is a Redis server: a
   * deployment that shares its sessions shares its limits as well.
   */
  SHUTTLE_SHARED_STATE_URL: z.string().optional(),
  SHUTTLE_SHARED_STATE_KEY_PREFIX: z.string().catch('shuttle'),
  SHUTTLE_SHARED_STATE_TLS_CA: z.string().optional(),
  SHUTTLE_SHARED_STATE_TLS_CA_BASE64: base64Env(),

  SHUTTLE_COOKIE_SECURE: optionalBoolEnv(),
  SHUTTLE_LOG_LEVEL: z.string().catch('info'),
  SHUTTLE_METRICS_TOKEN: z.string().optional(),
  SHUTTLE_MAX_BODY_BYTES: intEnv(10 * 1024 * 1024),
  SHUTTLE_WS_MAX_BUFFERED_BYTES: intEnv(256 * 1024),
  SHUTTLE_WS_MAX_BUFFERED_MESSAGES: intEnv(100),
  /**
   * The maximum size of a websocket message, in bytes.
   */
  SHUTTLE_WS_MAX_PAYLOAD_BYTES: intEnv(16 * 1024 * 1024),
  /**
   * The number of bytes that may be queued for a client that does not read.
   *
   * The connection is closed when the limit is reached, so the memory of
   * the process stays bounded.
   */
  SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES: intEnv(1024 * 1024),
  /**
   * How often the gateway pings the open websockets, in milliseconds.
   *
   * A value of zero disables the keepalive.
   */
  SHUTTLE_WS_PING_INTERVAL_MS: intEnv(30_000),
  /**
   * How long a websocket may stay silent before it is closed, in
   * milliseconds. It is a multiple of the ping interval.
   */
  SHUTTLE_WS_PONG_TIMEOUT_MS: intEnv(90_000),
  /**
   * The number of seconds a websocket may be idle before the runtime closes
   * it. The keepalive pings count as activity.
   */
  SHUTTLE_WS_IDLE_TIMEOUT_SECONDS: intEnv(120),
  /**
   * The number of websocket connections that may be open at the same time.
   * A limit of zero means "no limit".
   */
  SHUTTLE_WS_MAX_CONNECTIONS: intEnv(1_000),
  /**
   * How long the gateway waits for the handshake of the upstream.
   */
  SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS: intEnv(10_000, { min: 100 }),
  /**
   * The number of requests a single caller may make to *one route* in a
   * window.
   *
   * The budget is per route: a caller that is busy on one route does not
   * spend the budget of the other ones. The limit of the caller over all
   * the routes is `SHUTTLE_RATE_LIMIT_GLOBAL_MAX`.
   *
   * A limit of zero disables the limiter.
   */
  SHUTTLE_RATE_LIMIT_MAX: intEnv(0),
  SHUTTLE_RATE_LIMIT_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  /**
   * The number of requests a single caller may make over *all* the routes
   * in a window.
   *
   * It is the protection against a flood: the per route limiter alone
   * would let a caller make the budget of every route. A limit of zero
   * disables the limiter.
   */
  SHUTTLE_RATE_LIMIT_GLOBAL_MAX: intEnv(0),
  SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  /**
   * The number of login attempts a single caller may make in a window.
   */
  SHUTTLE_LOGIN_RATE_LIMIT_MAX: intEnv(30),
  SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS: intEnv(60_000, { min: 1_000 }),

  SHUTTLE_TRUSTED_PROXIES: listEnv(),
  SHUTTLE_EXTERNAL_PROTO: z.enum(['http', 'https']).catch('http'),
  SHUTTLE_SHUTDOWN_TIMEOUT_MS: intEnv(15_000),
  /**
   * The origins that are allowed to make requests to the gateway, in
   * addition to the origin of the gateway itself.
   */
  SHUTTLE_ALLOWED_ORIGINS: listEnv(),
  /**
   * Refuse the navigations from another site as well.
   */
  SHUTTLE_CSRF_STRICT: optionalBoolEnv(),
})

/** The session settings used when nothing else is configured. */
export function defaultSessionRuntimeOptions(): SessionRuntimeOptions {
  return {
    url: 'memory://local',
    keyPrefix: 'shuttle',
    ttlMs: DEFAULT_SESSION_TTL_MS,
    touchIntervalMs: DEFAULT_SESSION_TOUCH_INTERVAL_MS,
    maxSessions: DEFAULT_MAX_SESSIONS,
  }
}

/**
 * Reads the environment.
 *
 * A value that cannot be understood stops the gateway: the message names
 * the variable, so the operator knows what to fix.
 */
export function readEnv(env: Env = process.env): RuntimeOptions {
  const result = EnvSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'the environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`the environment is invalid: ${problems}`)
  }
  const parsed = result.data
  const nodeEnv = parsed.NODE_ENV ?? 'production'
  const production = nodeEnv === 'production'
  const scopes = parsed.SHUTTLE_OIDC_SCOPES.length
    ? parsed.SHUTTLE_OIDC_SCOPES
    : ['openid', 'profile', 'email', 'groups']

  // The secret signs the state cookie of the login flow. A secret that is
  // generated per process is only valid on the replica that generated it, so
  // a deployment with more than one replica would fail the login at random
  // and every restart would invalidate the logins that are in flight. A
  // production deployment has to configure it.
  if (production && !parsed.SHUTTLE_SESSION_SECRET) {
    throw new Error(
      'SHUTTLE_SESSION_SECRET must be set in a production environment: it signs the state cookie of the login flow and has to be the same on every replica'
    )
  }

  // The identity provider and the access service decide who a caller is and
  // what it may do. Their addresses have no default in production: the
  // defaults of the development environment point at the fixtures of the
  // repository, and a deployment that forgets to configure them would talk
  // to nobody (or to the wrong thing) instead of failing at the start.
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
  if (production && !parsed.SHUTTLE_OIDC_CLIENT_SECRET && !parsed.SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT) {
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

  const oidcIssuer = parsed.SHUTTLE_OIDC_ISSUER ?? 'http://localhost:5556/dex'
  const oidcClientId = parsed.SHUTTLE_OIDC_CLIENT_ID ?? 'shuttle'
  const accessUrl = parsed.SHUTTLE_ACCESS_URL ?? 'http://localhost:8090'

  // The state the replicas share lives in the session server when that one
  // is a Redis server: a deployment that shares its sessions shares its
  // limits and its cached decisions as well. A deployment with a single
  // replica keeps the state in the memory of the process.
  const sharedStateUrl =
    parsed.SHUTTLE_SHARED_STATE_URL ??
    (isRedisUrl(parsed.SHUTTLE_SESSION_URL) ? parsed.SHUTTLE_SESSION_URL : undefined)

  return {
    configPath: parsed.SHUTTLE_CONFIG,
    gatewayPort: parsed.SHUTTLE_GATEWAY_PORT,
    gatewayHost: parsed.SHUTTLE_GATEWAY_HOST,
    oidc: {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: parsed.SHUTTLE_OIDC_CLIENT_SECRET,
      redirectUri:
        parsed.SHUTTLE_OIDC_REDIRECT_URI ??
        `http://localhost:${parsed.SHUTTLE_GATEWAY_PORT}/auth/callback`,
      scopes,
      audience: parsed.SHUTTLE_OIDC_AUDIENCE,
      rolesClaim: parsed.SHUTTLE_OIDC_ROLES_CLAIM,
      // An identity provider that is not served over https is only allowed
      // outside a production environment: a deployment terminates TLS in
      // front of the provider.
      allowInsecureIssuer: parsed.SHUTTLE_OIDC_ALLOW_INSECURE ?? !production,
    },
    access: {
      baseUrl: accessUrl,
      token: parsed.SHUTTLE_ACCESS_TOKEN,
      timeoutMs: parsed.SHUTTLE_ACCESS_TIMEOUT_MS,
      cacheTtlMs: parsed.SHUTTLE_ACCESS_CACHE_TTL_MS,
    },
    session: {
      /**
       * The session store is selected by the scheme of the url, so an
       * infrastructure module only has to provide a single value.
       */
      url: parsed.SHUTTLE_SESSION_URL,
      keyPrefix: parsed.SHUTTLE_SESSION_KEY_PREFIX,
      ttlMs: parsed.SHUTTLE_SESSION_TTL_MS,
      touchIntervalMs: parsed.SHUTTLE_SESSION_TOUCH_INTERVAL_MS,
      tlsCa: parsed.SHUTTLE_SESSION_TLS_CA ?? parsed.SHUTTLE_SESSION_TLS_CA_BASE64,
      maxSessions: parsed.SHUTTLE_SESSION_MAX_SESSIONS,
    },
    sharedStateUrl,
    sharedStateKeyPrefix: parsed.SHUTTLE_SHARED_STATE_KEY_PREFIX,
    sharedStateTlsCa:
      parsed.SHUTTLE_SHARED_STATE_TLS_CA ??
      parsed.SHUTTLE_SHARED_STATE_TLS_CA_BASE64 ??
      parsed.SHUTTLE_SESSION_TLS_CA ??
      parsed.SHUTTLE_SESSION_TLS_CA_BASE64,
    sessionSecret: parsed.SHUTTLE_SESSION_SECRET ?? randomBytes(32).toString('hex'),
    cookieSecure: parsed.SHUTTLE_COOKIE_SECURE ?? production,
    logLevel: parseLogLevel(parsed.SHUTTLE_LOG_LEVEL, 'info'),
    metricsToken: parsed.SHUTTLE_METRICS_TOKEN,
    maxBodyBytes: parsed.SHUTTLE_MAX_BODY_BYTES,
    websocketMaxBufferedBytes: parsed.SHUTTLE_WS_MAX_BUFFERED_BYTES,
    websocketMaxBufferedMessages: parsed.SHUTTLE_WS_MAX_BUFFERED_MESSAGES,
    websocketMaxPayloadBytes: parsed.SHUTTLE_WS_MAX_PAYLOAD_BYTES,
    websocketBackpressureLimitBytes: parsed.SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES,
    websocketPingIntervalMs: parsed.SHUTTLE_WS_PING_INTERVAL_MS,
    websocketPongTimeoutMs: parsed.SHUTTLE_WS_PONG_TIMEOUT_MS,
    websocketIdleTimeoutSeconds: parsed.SHUTTLE_WS_IDLE_TIMEOUT_SECONDS,
    websocketMaxConnections: parsed.SHUTTLE_WS_MAX_CONNECTIONS,
    websocketHandshakeTimeoutMs: parsed.SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS,
    rateLimitMax: parsed.SHUTTLE_RATE_LIMIT_MAX,
    rateLimitWindowMs: parsed.SHUTTLE_RATE_LIMIT_WINDOW_MS,
    rateLimitGlobalMax: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_MAX,
    rateLimitGlobalWindowMs: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS,
    loginRateLimitMax: parsed.SHUTTLE_LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowMs: parsed.SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS,
    trustedProxies: parsed.SHUTTLE_TRUSTED_PROXIES,
    externalProto: parsed.SHUTTLE_EXTERNAL_PROTO,
    shutdownTimeoutMs: parsed.SHUTTLE_SHUTDOWN_TIMEOUT_MS,
    allowedOrigins: parsed.SHUTTLE_ALLOWED_ORIGINS,
    csrfStrict: parsed.SHUTTLE_CSRF_STRICT ?? false,
  }
}
