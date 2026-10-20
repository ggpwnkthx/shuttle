import { z } from 'zod'

/**
 * Schema for the Shuttle route configuration file.
 *
 * The configuration is the single source of truth for routing, authentication
 * policy and upstream selection. It is validated as a whole before it is
 * activated, and rejected as a whole if anything is invalid.
 */

const HOST_PATTERN_MAX = 253
const PATH_TEMPLATE_MAX = 512
const ROUTE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A placeholder of a path template: `{name}`. */
const PLACEHOLDER_PATTERN = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/
/** A literal segment of a path template. */
const LITERAL_SEGMENT_PATTERN = /^[^{}:*]+$/
const UUID_SCHEMA = z.string().uuid()

export const AuthModeSchema = z.enum(['none', 'session', 'jwt', 'any'])
export type AuthMode = z.infer<typeof AuthModeSchema>

/**
 * How the redirects of an upstream are handled.
 *
 * - `rewrite` the location is rewritten so that it stays inside the gateway
 *   and keeps the prefix the upstream is mounted under
 * - `pass`     the location is forwarded unchanged
 */
export const RedirectModeSchema = z.enum(['rewrite', 'pass'])
export type RedirectMode = z.infer<typeof RedirectModeSchema>

export const WorkspaceAccessSchema = z.strictObject({
  /** Name of the path template placeholder that carries the workspace id. */
  param: z.string().regex(PARAM_NAME_PATTERN, 'workspace param must be a valid identifier'),
  /** Reject workspace identifiers that are not UUIDs. */
  requireUuid: z.boolean().default(true),
})

/**
 * The authentication policy of a route.
 *
 * The object is strict: an unknown key is a configuration error, not a
 * silently ignored setting. A policy that the gateway does not implement
 * (a role check, for example) has to be rejected loudly, because a setting
 * that looks active but is not is a security hole.
 */
export const AuthPolicySchema = z.strictObject({
  mode: AuthModeSchema.default('none'),
  workspace: WorkspaceAccessSchema.optional(),
})
export type AuthPolicy = z.infer<typeof AuthPolicySchema>

export const TimeoutsSchema = z.strictObject({
  connectMs: z.number().int().min(100).max(120_000).default(5_000),
  headersMs: z.number().int().min(100).max(600_000).default(30_000),
  bodyMs: z.number().int().min(100).max(3_600_000).default(300_000),
})
export type Timeouts = z.infer<typeof TimeoutsSchema>

/**
 * The timeouts of a route.
 *
 * Every budget is optional: a route that only sets `connectMs` inherits the
 * header and the body budget of the configuration.
 */
export const RouteTimeoutsSchema = z.strictObject({
  connectMs: z.number().int().min(100).max(120_000).optional(),
  headersMs: z.number().int().min(100).max(600_000).optional(),
  bodyMs: z.number().int().min(100).max(3_600_000).optional(),
})
export type RouteTimeouts = z.infer<typeof RouteTimeoutsSchema>

export const RouteSchema = z.strictObject({
  id: z.string().regex(ROUTE_ID_PATTERN, 'route id must be lowercase kebab-case'),
  match: z.strictObject({
    /** `example.com`, `*.example.com` or `*` for any host. */
    host: z.string().min(1).max(HOST_PATTERN_MAX),
    /** Path template, may contain `{param}` placeholders. */
    path: z
      .string()
      .startsWith('/')
      .max(PATH_TEMPLATE_MAX)
      .refine(isValidPathTemplate, {
        message:
          'a path template is a list of segments; a segment is a literal or a {placeholder}, a literal must not contain "{", "}", ":" or "*"',
      }),
  }),
  upstream: z.url(),
  /**
   * The policy of the route.
   *
   * A route without a policy uses the policy of `defaults`. A policy of a
   * route *replaces* the default policy, it is not merged with it.
   */
  auth: AuthPolicySchema.optional(),
  timeouts: RouteTimeoutsSchema.optional(),
  websocket: z.boolean().default(false),
  /**
   * How the redirects of the upstream are handled.
   *
   * The default rewrites them: an absolute location that points at the
   * upstream would otherwise leak its internal hostname to the browser, and
   * a relative location would leave the prefix the application is mounted
   * under.
   */
  redirects: RedirectModeSchema.default('rewrite'),
  /** Maximum accepted request body size in bytes (0 disables the limit). */
  maxBodyBytes: z.number().int().min(0).max(1_073_741_824).optional(),
})
type RouteInput = z.infer<typeof RouteSchema>

/** A route with the policy that applies to it. */
export type RouteConfig = Omit<RouteInput, 'auth'> & { auth: AuthPolicy }

export const DefaultsSchema = z.strictObject({
  /** The policy of the routes that do not declare one. */
  auth: AuthPolicySchema.prefault({ mode: 'none' }),
  timeouts: TimeoutsSchema.prefault({}),
  /**
   * The default request body limit. When it is not set, the limit of the
   * environment (`SHUTTLE_MAX_BODY_BYTES`) is used.
   */
  maxBodyBytes: z.number().int().min(0).max(1_073_741_824).optional(),
})
export type Defaults = z.infer<typeof DefaultsSchema>

export interface ShuttleConfig {
  version: 1
  defaults: Defaults
  reservedPaths: string[]
  trustedProxies: string[]
  routes: RouteConfig[]
}

/**
 * The paths the gateway serves itself.
 *
 * They are part of the security invariant of the gateway, exactly like the
 * stripped headers and the identity header names, so they are not
 * configurable: an operator cannot accidentally expose the metrics endpoint
 * or shadow the login flow with a route.
 */
export const GATEWAY_PATHS = [
  '/healthz',
  '/readyz',
  '/metrics',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
] as const

/**
 * Normalizes a path for the comparison of the reserved paths.
 *
 * The trailing slashes are removed: `/metrics` and `/metrics/` are the same
 * path for the operator, and the gateway has to reserve both of them.
 */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Reports whether a path is reserved for the gateway itself.
 *
 * The paths of `GATEWAY_PATHS` are always reserved, the additional paths of
 * the configuration are reserved on top of them. A reserved path is never
 * routed to an upstream, not even in the spelling with a trailing slash:
 * the gateway owns the name, so an upstream never sees it.
 */
export function isReservedPath(config: ShuttleConfig, path: string): boolean {
  const normalized = normalizePath(path)
  if ((GATEWAY_PATHS as readonly string[]).some((p) => normalizePath(p) === normalized)) return true
  return config.reservedPaths.some((p) => normalizePath(p) === normalized)
}

const RawConfigSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: DefaultsSchema.prefault({}),
    /**
     * Additional paths the gateway reserves for itself. They are never
     * routed to an upstream. The paths the gateway always serves itself
     * (`GATEWAY_PATHS`) are reserved whether or not they are listed here.
     */
    reservedPaths: z.array(z.string().startsWith('/')).default([]),
    /** CIDR ranges / IPs of reverse proxies whose forwarding headers are trusted. */
    trustedProxies: z.array(z.string().min(1)).default([]),
    routes: z.array(RouteSchema).min(1, 'at least one route is required'),
  })
  .superRefine((config, ctx) => {
    // A workspace check without an authentication mode can never be
    // satisfied: the gateway would ask the access service about a caller it
    // never authenticated. The default policy is checked on its own, because a
    // route that declares its own policy does not inherit it — a broken
    // default would otherwise stay unnoticed until a route without a policy
    // was added.
    if (config.defaults.auth.mode === 'none' && config.defaults.auth.workspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaults', 'auth'],
        message: 'a workspace check needs an authentication mode other than "none"',
      })
    }
    for (const [index, route] of config.routes.entries()) {
      if (route.auth?.mode === 'none' && route.auth.workspace) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'auth'],
          message: 'a workspace check needs an authentication mode other than "none"',
        })
      }
    }
  })

/**
 * The configuration of the gateway.
 *
 * The route table is resolved while it is parsed: a route without a policy
 * gets the policy of `defaults`, so the gateway only ever sees the policy
 * that applies to a request.
 */
export const ShuttleConfigSchema = RawConfigSchema.transform(
  (config): ShuttleConfig => ({
    version: 1,
    defaults: config.defaults,
    reservedPaths: config.reservedPaths,
    trustedProxies: config.trustedProxies,
    routes: config.routes.map((route) => ({
      ...route,
      auth: route.auth ?? config.defaults.auth,
    })),
  })
)

export class ConfigValidationError extends Error {
  readonly details: string[]
  constructor(details: string[]) {
    super(`invalid configuration: ${details.join('; ')}`)
    this.name = 'ConfigValidationError'
    this.details = details
  }
}

/** Validates raw JSON against the schema, returning a typed config. */
export function parseConfig(raw: unknown): ShuttleConfig {
  const result = ShuttleConfigSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    throw new ConfigValidationError(details)
  }
  return result.data
}

/**
 * Reports whether a path template has a shape the gateway can match.
 *
 * A template is a list of segments separated by `/`. A segment is either a
 * literal or a `{placeholder}`; a literal must not contain a character that
 * the path matcher would read as a placeholder (`{`, `}`, `:`) or as a
 * wildcard (`*`).
 */
export function isValidPathTemplate(value: string): boolean {
  const segments = value.split('/').filter((segment) => segment !== '')
  return segments.every(
    (segment) => LITERAL_SEGMENT_PATTERN.test(segment) || PLACEHOLDER_PATTERN.test(segment)
  )
}

export function isUuid(value: string): boolean {
  return UUID_SCHEMA.safeParse(value).success
}
