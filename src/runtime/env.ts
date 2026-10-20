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
  allowAnonymous: boolean
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
  /** The secret that signs the state cookie and that derives the signature key. */
  secret: string
}

/** The settings of the state the replicas share. */
export interface SharedStateSettings {
  url?: string
  keyPrefix: string
  tlsCa?: string
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
  route: { max: number; windowMs: number }
  global: { max: number; windowMs: number }
  login: { max: number; windowMs: number }
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
  limits: LimitSettings
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
  SHUTTLE_ACCESS_CACHE_TTL_MS: intEnv(5_000, { min: 0 }),
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
  SHUTTLE_SESSION_TLS_CA: tlsCaEnv(),
  SHUTTLE_SESSION_TLS_CA_BASE64: tlsCaEnv(),

  SHUTTLE_SHARED_STATE_URL: z.string().optional(),
  SHUTTLE_SHARED_STATE_KEY_PREFIX: z.string().default('shuttle'),
  SHUTTLE_SHARED_STATE_TLS_CA: tlsCaEnv(),
  SHUTTLE_SHARED_STATE_TLS_CA_BASE64: tlsCaEnv(),

  SHUTTLE_COOKIE_SECURE: boolEnv(),
  SHUTTLE_LOG_LEVEL: z.string().optional(),
  SHUTTLE_METRICS_TOKEN: z.string().optional(),
  SHUTTLE_MAX_BODY_BYTES: intEnv(10_485_760, { min: 0 }),

  SHUTTLE_TRUSTED_PROXIES: listEnv(),
  SHUTTLE_EXTERNAL_PROTO: z.enum(['http', 'https']).default('http'),
  SHUTTLE_ALLOWED_ORIGINS: listEnv(),
  SHUTTLE_CSRF_STRICT: boolEnv(),

  SHUTTLE_RATE_LIMIT_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
  SHUTTLE_RATE_LIMIT_GLOBAL_MAX: intEnv(0, { min: 0 }),
  SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS: intEnv(60_000, { min: 1_000 }),
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

  const scopes =
    parsed.SHUTTLE_OIDC_SCOPES.length > 0
      ? parsed.SHUTTLE_OIDC_SCOPES
      : ['openid', 'profile', 'email', 'groups']

  // The state the replicas share lives in the session server when that one
  // is a Redis server: a deployment that shares its sessions shares its
  // limits and its cached decisions as well.
  const sharedStateUrl =
    parsed.SHUTTLE_SHARED_STATE_URL ??
    (isRedisUrl(parsed.SHUTTLE_SESSION_URL) ? parsed.SHUTTLE_SESSION_URL : undefined)

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
      allowAnonymous: parsed.SHUTTLE_ACCESS_ALLOW_ANONYMOUS ?? false,
    },
    session: {
      url: parsed.SHUTTLE_SESSION_URL,
      keyPrefix: parsed.SHUTTLE_SESSION_KEY_PREFIX,
      ttlMs: parsed.SHUTTLE_SESSION_TTL_MS,
      maxAgeMs: parsed.SHUTTLE_SESSION_MAX_AGE_MS,
      touchIntervalMs: parsed.SHUTTLE_SESSION_TOUCH_INTERVAL_MS,
      maxSessions: parsed.SHUTTLE_SESSION_MAX_SESSIONS,
      tlsCa: parsed.SHUTTLE_SESSION_TLS_CA ?? parsed.SHUTTLE_SESSION_TLS_CA_BASE64,
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
    },
    browser: {
      cookieSecure: parsed.SHUTTLE_COOKIE_SECURE ?? production,
      allowedOrigins: parsed.SHUTTLE_ALLOWED_ORIGINS,
      csrfStrict: parsed.SHUTTLE_CSRF_STRICT ?? false,
    },
    limits: {
      maxBodyBytes: parsed.SHUTTLE_MAX_BODY_BYTES,
      route: { max: parsed.SHUTTLE_RATE_LIMIT_MAX, windowMs: parsed.SHUTTLE_RATE_LIMIT_WINDOW_MS },
      global: {
        max: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_MAX,
        windowMs: parsed.SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS,
      },
      login: {
        max: parsed.SHUTTLE_LOGIN_RATE_LIMIT_MAX,
        windowMs: parsed.SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS,
      },
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
    },
    observability: {
      logLevel: parseLogLevel(parsed.SHUTTLE_LOG_LEVEL),
      metricsToken: parsed.SHUTTLE_METRICS_TOKEN,
    },
    shutdownTimeoutMs: parsed.SHUTTLE_SHUTDOWN_TIMEOUT_MS,
  }
}

/** Reports whether an url names a Redis server. */
export function isRedisUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.startsWith('redis://') || url.startsWith('rediss://')
}
