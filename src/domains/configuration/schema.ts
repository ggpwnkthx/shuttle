/**
 * The schema of the configuration file.
 *
 * The file is the single source of truth for the routing, for the policy of
 * the routes and for the upstreams. It is validated as a whole and it is
 * rejected as a whole when anything is invalid: a configuration that is
 * half applied is a configuration nobody can reason about.
 *
 * The schemas of the domains that own the pieces are composed here: the
 * identity and the match of a route come from the routing domain, the
 * policy of the authentication comes from the authentication domain.
 */

import { z } from 'zod'
import { AuthPolicySchema, type AuthPolicy } from '../authentication'
import { HostPatternSchema, PathTemplateSchema, RouteIdSchema, placeholderNames } from '../routing'

/** The maximum size of a body, in bytes. */
export const MAX_BODY_BYTES_LIMIT = 1_073_741_824

/**
 * The budgets of the phases of an exchange.
 *
 * - `responseMs`   the time between the end of the upload and the answer
 * - `firstByteMs`  the time between the answer and the first byte of its body
 * - `bodyMs`       the time between two chunks, in both directions
 */
export const TimeoutsSchema = z.strictObject({
  responseMs: z.number().int().min(100).max(600_000).default(5_000),
  firstByteMs: z.number().int().min(100).max(900_000).default(30_000),
  bodyMs: z.number().int().min(100).max(3_600_000).default(300_000),
})
export type Timeouts = z.infer<typeof TimeoutsSchema>

/**
 * The budgets of a route.
 *
 * Every budget is optional: a route that only sets `responseMs` keeps the
 * budgets of the configuration for the other phases.
 */
export const RouteTimeoutsSchema = z.strictObject({
  responseMs: z.number().int().min(100).max(600_000).optional(),
  firstByteMs: z.number().int().min(100).max(900_000).optional(),
  bodyMs: z.number().int().min(100).max(3_600_000).optional(),
})
export type RouteTimeouts = z.infer<typeof RouteTimeoutsSchema>

/**
 * The upstream of a route.
 *
 * The url of an upstream may not carry a query string and it may not carry a
 * fragment: the query string of the request replaces the one of the upstream
 * and a fragment never reaches the upstream, so such an url would silently
 * do something else than it says.
 */
const UpstreamSchema = z
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'an upstream is served over http or https',
  })
  .refine((value) => !new URL(value).search, {
    message: 'an upstream may not carry a query string',
  })
  .refine((value) => !new URL(value).hash, {
    message: 'an upstream may not carry a fragment',
  })

/** A route of the configuration file. */
export const RouteSchema = z.strictObject({
  id: RouteIdSchema,
  match: z.strictObject({
    /** `example.com`, `*.example.com` or `*` for any host. */
    host: HostPatternSchema,
    /** Path template, may contain `{param}` placeholders. */
    path: PathTemplateSchema,
  }),
  upstream: UpstreamSchema,
  /**
   * The policy of the route.
   *
   * A route without a policy uses the policy of `defaults`. A policy of a
   * route *replaces* the default policy, it is not merged with it.
   */
  auth: AuthPolicySchema.optional(),
  timeouts: RouteTimeoutsSchema.optional(),
  websocket: z.boolean().default(false),
  /** Maximum accepted request body size in bytes (0 disables the limit). */
  maxBodyBytes: z.number().int().min(0).max(MAX_BODY_BYTES_LIMIT).optional(),
})
export type RouteFile = z.infer<typeof RouteSchema>

/** The defaults of the routes that do not declare their own policy. */
export const DefaultsSchema = z.strictObject({
  auth: AuthPolicySchema.prefault({ mode: 'none' }),
  timeouts: TimeoutsSchema.prefault({}),
  /**
   * The default request body limit. When it is not set, the limit of the
   * environment (`SHUTTLE_MAX_BODY_BYTES`) is used.
   */
  maxBodyBytes: z.number().int().min(0).max(MAX_BODY_BYTES_LIMIT).optional(),
})
export type Defaults = z.infer<typeof DefaultsSchema>

/**
 * The paths the gateway serves itself.
 *
 * They are part of the security invariant of the gateway, exactly like the
 * stripped headers and the identity header names, so they are not
 * configurable: an operator cannot accidentally expose the metrics endpoint
 * or shadow the login flow with a route.
 */
export const GATEWAY_ENDPOINTS = {
  health: '/healthz',
  ready: '/readyz',
  metrics: '/metrics',
  login: '/auth/login',
  callback: '/auth/callback',
  logout: '/auth/logout',
} as const

/** The paths the gateway serves itself. */
export const GATEWAY_RESERVED_PATHS: readonly string[] = Object.values(GATEWAY_ENDPOINTS)

/** The whole configuration file. */
export const ShuttleConfigSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: DefaultsSchema.prefault({}),
    /**
     * Additional paths the gateway reserves for itself. They are never
     * routed to an upstream. The paths the gateway always serves itself are
     * reserved whether or not they are listed here.
     */
    reservedPaths: z.array(z.string().startsWith('/')).default([]),
    /** CIDR ranges / IPs of reverse proxies whose forwarding headers are trusted. */
    trustedProxies: z.array(z.string().min(1)).default([]),
    routes: z.array(RouteSchema).min(1, 'at least one route is required'),
  })
  .superRefine((config, ctx) => {
    for (const [index, route] of config.routes.entries()) {
      const workspace = route.auth?.workspace
      if (!workspace) continue
      // The workspace check names a placeholder of the path of the route: a
      // policy that names one the path does not have could never be
      // satisfied.
      const placeholders = placeholderNames(route.match.path)
      if (!placeholders.includes(workspace.param)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'auth', 'workspace', 'param'],
          message: `the path "${route.match.path}" has no placeholder "${workspace.param}"`,
        })
      }
    }
  })
export type ShuttleConfigFile = z.infer<typeof ShuttleConfigSchema>

/** A configuration that could not be used. */
export class ConfigValidationError extends Error {
  override readonly cause: unknown
  /** The problems of the configuration, one per line. */
  readonly details: string[]

  constructor(details: string[], cause?: unknown) {
    super(`invalid configuration: ${details.join('; ')}`)
    this.name = 'ConfigValidationError'
    this.details = details
    this.cause = cause
  }
}

/**
 * Validates a raw configuration.
 *
 * The result is a configuration whose routes carry the policy that applies
 * to them: a route without a policy gets the policy of the defaults, so the
 * gateway only ever sees the policy that applies to a request.
 */
export function parseConfig(raw: unknown): ShuttleConfigFile {
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
 * The policy of a route, with the defaults of the configuration applied.
 *
 * The policy of a route replaces the default policy, the budgets are merged
 * field by field and the limit of the body is the one of the route, then the
 * one of the defaults, then the one of the environment.
 */
export function effectivePolicy(
  route: RouteFile,
  defaults: Defaults,
  environmentMaxBodyBytes: number
): {
  auth: AuthPolicy
  timeouts: Timeouts
  maxBodyBytes: number
} {
  return {
    auth: route.auth ?? defaults.auth,
    timeouts: {
      responseMs: route.timeouts?.responseMs ?? defaults.timeouts.responseMs,
      firstByteMs: route.timeouts?.firstByteMs ?? defaults.timeouts.firstByteMs,
      bodyMs: route.timeouts?.bodyMs ?? defaults.timeouts.bodyMs,
    },
    maxBodyBytes: route.maxBodyBytes ?? defaults.maxBodyBytes ?? environmentMaxBodyBytes,
  }
}
