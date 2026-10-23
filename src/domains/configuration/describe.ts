/**
 * The description of the configuration that is running.
 *
 * A route table is a JSON file and an environment with dozens of
 * variables: the policy a route is actually running with is spread over
 * the two. The description gathers it in one place, so an operator reads
 * what the gateway does instead of reconstructing it from the sources.
 *
 * The description also names the settings that are **permissive**: a route
 * that accepts an unauthenticated caller, a route that authenticates the
 * caller without asking the access service, a route that hands the
 * credential of the caller to the upstream. They are not errors: a
 * deployment may want them. They are settings that look active but that
 * nobody may have read, and a warning that says so is worth more than a
 * silent default.
 */

import type { AuthMode } from '../authentication'
import type { CompiledRoute } from '../routing'
import type { CrossSitePolicy, Timeouts } from './schema'
import type { ConfigurationSnapshot } from './store'
import type { CompiledTable } from './compile'
import type { EffectiveRoute } from './routes'

/** The codes of the warnings of a configuration. */
export type ConfigurationWarningCode =
  /** The route forwards an unauthenticated caller. */
  | 'unauthenticated_route'
  /** The route authenticates the caller but never asks the access service. */
  | 'no_workspace_check'
  /** The route hands the credential of the caller to the upstream. */
  | 'authorization_forwarded'
  /** The route accepts a navigation from another site. */
  | 'cross_site_allowed'
  /** The route accepts a body of any size. */
  | 'unbounded_body'
  /** The route names several upstreams and the failover is limited. */
  | 'limited_failover'

/** A warning about a setting that is permissive. */
export interface ConfigurationWarning {
  /** The route the warning is about, or null for the whole configuration. */
  routeId: string | null
  code: ConfigurationWarningCode
  /** The warning, in one sentence. */
  message: string
}

/** The description of a route. */
export interface RouteDescription {
  id: string
  /** The host the route matches. */
  host: string
  /** The path the route matches. */
  path: string
  /**
   * The methods the route accepts.
   *
   * An empty list means that the route accepts every method.
   */
  methods: string[]
  /** The path the upstream receives, when it is not the path of the request. */
  rewrite: string | null
  /** The base urls of the upstreams, in the order they are tried. */
  upstreams: string[]
  /** The credential the route accepts. */
  auth: AuthMode
  /** The name of the placeholder that carries the workspace identifier. */
  workspace: string | null
  /** Whether a workspace identifier that is not a UUID is refused. */
  requireUuid: boolean
  /** The policy of the cross site requests of the route. */
  crossSite: CrossSitePolicy
  /** Whether the credential of the caller reaches the upstream. */
  forwardAuthorization: boolean
  /** Whether the route accepts a websocket. */
  websocket: boolean
  /** The limit of the body of a request, 0 means that there is none. */
  maxBodyBytes: number
  /** The budgets of the exchange. */
  timeouts: Timeouts
  /** The lifetime of a cached decision of the access service. */
  accessCacheTtlMs: number | null
  /**
   * Whether the access service is asked about the route when it names no
   * workspace.
   */
  accessCheck: boolean
  /** The grace of an outage of the access service, in milliseconds. */
  accessStaleGraceMs: number
}

/** The description of a whole configuration. */
export interface ConfigurationDescription {
  /** The generation of the configuration. */
  revision: number
  /** The file the configuration was read from. */
  source: string
  /** The number of the routes. */
  routeCount: number
  /** The routes, in the order of the precedence of the matcher. */
  routes: RouteDescription[]
  /** The settings that are permissive. */
  warnings: ConfigurationWarning[]
}

/** Describes a route. */
function describeRoute(route: CompiledRoute<EffectiveRoute>): RouteDescription {
  const policy = route.payload
  return {
    id: route.id,
    host: route.definition.host,
    path: route.definition.path,
    methods: [...route.methods],
    rewrite: route.definition.rewrite ?? null,
    upstreams: [...policy.upstreams],
    auth: policy.auth.mode,
    workspace: policy.auth.workspace?.param ?? null,
    requireUuid: policy.auth.workspace?.requireUuid ?? false,
    crossSite: policy.crossSite,
    forwardAuthorization: policy.forwardAuthorization,
    websocket: policy.websocket,
    maxBodyBytes: policy.maxBodyBytes,
    timeouts: { ...policy.timeouts },
    accessCacheTtlMs: policy.accessCacheTtlMs ?? null,
    accessCheck: policy.accessCheck,
    accessStaleGraceMs: policy.accessStaleGraceMs,
  }
}

/**
 * Names the settings of a route that are permissive.
 *
 * The list is short on purpose: a warning that is raised for everything is
 * a warning nobody reads.
 */
function warningsOf(route: CompiledRoute<EffectiveRoute>): ConfigurationWarning[] {
  const policy = route.payload
  const warnings: ConfigurationWarning[] = []
  const acceptsASession = policy.auth.mode === 'session' || policy.auth.mode === 'any'

  if (policy.auth.mode === 'none') {
    warnings.push({
      routeId: route.id,
      code: 'unauthenticated_route',
      message: 'the route forwards callers that were not authenticated',
    })
  }
  if (policy.auth.mode !== 'none' && !policy.auth.workspace && !policy.accessCheck) {
    warnings.push({
      routeId: route.id,
      code: 'no_workspace_check',
      message:
        'the route authenticates the caller but never asks the access service about the workspace',
    })
  }
  if (policy.forwardAuthorization) {
    warnings.push({
      routeId: route.id,
      code: 'authorization_forwarded',
      message: 'the credential of the caller reaches the upstream of the route',
    })
  }
  if (acceptsASession && policy.crossSite !== 'strict') {
    warnings.push({
      routeId: route.id,
      code: 'cross_site_allowed',
      message: 'the route accepts a navigation from another site while it accepts a session',
    })
  }
  if (policy.maxBodyBytes === 0) {
    warnings.push({
      routeId: route.id,
      code: 'unbounded_body',
      message: 'the route accepts a body of any size',
    })
  }
  if (policy.upstreams.length > 1) {
    warnings.push({
      routeId: route.id,
      code: 'limited_failover',
      message:
        'the next upstream is tried only when the connection fails and only for a request that may be sent twice',
    })
  }
  return warnings
}

/**
 * Describes the configuration that is running.
 *
 * The description is a plain value: it holds nothing of the gateway and it
 * may be written in a log, printed by a command or compared in a test.
 */
export function describeConfiguration(snapshot: ConfigurationSnapshot): ConfigurationDescription {
  const routes = snapshot.routes.map((route) => describeRoute(route))
  const warnings = snapshot.routes.flatMap((route) => warningsOf(route))
  return {
    revision: snapshot.revision,
    source: snapshot.source,
    routeCount: routes.length,
    routes,
    warnings,
  }
}

/**
 * Describes a table that is not running.
 *
 * The control plane validates a table it never publishes (§12.7 of the
 * specification), and it reports the warnings of the table the same way the
 * gateway reports the warnings of the table that is running: the operator
 * reads one description, not two.
 */
export function describeTable(table: CompiledTable): {
  routeCount: number
  routes: RouteDescription[]
  warnings: ConfigurationWarning[]
} {
  const routes = table.routes.map((route) => describeRoute(route))
  const warnings = table.routes.flatMap((route) => warningsOf(route))
  return { routeCount: routes.length, routes, warnings }
}
