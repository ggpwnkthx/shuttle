/**
 * The routes of a configuration and the policy that applies to them.
 *
 * The policy of a route is computed once, when the table is loaded: the
 * defaults of the table and the defaults of the environment are merged into
 * it, and the gateway only ever sees the policy that applies to a request.
 *
 * The compilation lives here and not in the store, because the control
 * plane validates a table it never publishes (§12.7 of the specification)
 * and it has to compile it exactly the way the gateway does.
 */

import type { AuthPolicy } from '../authentication'
import { compileRoute, sortRoutes, type CompiledRoute } from '../routing'
import {
  effectivePolicy,
  type CrossSitePolicy,
  type Defaults,
  type RouteFile,
  type Timeouts,
} from './schema'

/** The policy that applies to a route. */
export interface EffectiveRoute {
  id: string
  /**
   * The base urls of the upstreams, in the order they are tried.
   *
   * A route may name one upstream or several.
   */
  upstreams: string[]
  auth: AuthPolicy
  timeouts: Timeouts
  /** The limit of the body of a request, 0 disables it. */
  maxBodyBytes: number
  /**
   * The size of a body that may be sent again to a second upstream, in
   * bytes. 0 disables the replay: every body is streamed and every request
   * is sent once.
   */
  replayMaxBytes: number
  websocket: boolean
  /**
   * The policy of the cross site requests of the route.
   *
   * `strict` refuses a navigation from another site as well.
   */
  crossSite: CrossSitePolicy
  /**
   * Whether the `Authorization` header of the caller is forwarded to the
   * upstream of the route.
   */
  forwardAuthorization: boolean
  /**
   * The lifetime of a cached decision of the access service for the route,
   * in milliseconds. Undefined means the lifetime of the environment.
   */
  accessCacheTtlMs?: number
  /**
   * How long a decision of the access service may be served after the
   * service became unreachable, in milliseconds. Zero disables it.
   */
  accessStaleGraceMs: number
  /**
   * Whether the access service is asked about the route when it names no
   * workspace.
   */
  accessCheck: boolean
}

/** The defaults of the deployment, the ones the table does not carry. */
export interface EnvironmentDefaults {
  /** The limit of the body when neither the route nor the defaults set one. */
  defaultMaxBodyBytes: number
  /** The budget of one attempt to an upstream when neither the route nor the defaults set one. */
  defaultUpstreamAttemptMs?: number
  /** The size of a replayable body when neither the route nor the defaults set one. */
  defaultReplayMaxBytes?: number
  /** The grace of an outage of the access service when neither the route nor the defaults set one. */
  defaultAccessStaleGraceMs?: number
}

/**
 * Compiles the routes of a table with the policy that applies to them.
 *
 * The routes come back sorted by the precedence of the matcher (§3.3): the
 * order of the file is not the order of the matching.
 */
export function compileRoutes(
  routes: RouteFile[],
  defaults: Defaults,
  environment: EnvironmentDefaults
): CompiledRoute<EffectiveRoute>[] {
  const compiled = routes.map((route) => {
    const policy = effectivePolicy(route, defaults, {
      maxBodyBytes: environment.defaultMaxBodyBytes,
      upstreamAttemptMs: environment.defaultUpstreamAttemptMs ?? 0,
      replayMaxBytes: environment.defaultReplayMaxBytes ?? 0,
      accessStaleGraceMs: environment.defaultAccessStaleGraceMs ?? 0,
    })
    return compileRoute(
      {
        id: route.id,
        host: route.match.host,
        path: route.match.path,
        rewrite: route.rewrite,
        methods: route.match.methods,
      },
      {
        id: route.id,
        upstreams: policy.upstreams,
        auth: policy.auth,
        timeouts: policy.timeouts,
        maxBodyBytes: policy.maxBodyBytes,
        replayMaxBytes: policy.replayMaxBytes,
        websocket: route.websocket,
        crossSite: policy.crossSite,
        forwardAuthorization: policy.forwardAuthorization,
        accessCacheTtlMs: policy.accessCacheTtlMs,
        accessStaleGraceMs: policy.accessStaleGraceMs,
        accessCheck: policy.accessCheck,
      }
    )
  })
  return sortRoutes(compiled)
}
