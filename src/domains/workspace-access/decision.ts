/**
 * The decisions of the access service.
 *
 * A decision is explicit: the service says whether the caller may use the
 * workspace or not. A decision that cannot be read is a denial: the gateway
 * never lets a caller in because the service had a hiccup.
 *
 * The decision carries its **kind**, and the kind is what the caller and
 * the operator see:
 *
 * | Kind | What it means | What the caller gets |
 * | --- | --- | --- |
 * | `allowed` | The service said yes. | The request is forwarded. |
 * | `denied` | The service said no. | `403 workspace_forbidden` |
 * | `unavailable` | The service could not be asked, or its answer could not be read. | `503 access_unavailable` |
 *
 * The two refusals are not the same thing: a denial is the policy of the
 * platform and it is the same answer for every caller, while an outage is a
 * failure of the infrastructure and it is worth retrying. Answering `403`
 * to an outage tells the caller that the workspace is not available to it,
 * and an outage that looks like a denial is an outage nobody pages on.
 */

/** The kind of a decision of the access service. */
export type AccessDecisionKind = 'allowed' | 'denied' | 'unavailable'

/** A decision of the access service. */
export interface AccessDecision {
  /** True when the caller may use the workspace. */
  allow: boolean
  /**
   * The kind of the decision.
   *
   * `denied` is an explicit decision of the service and `unavailable` is a
   * failure to obtain one. Only an explicit decision is cached.
   */
  kind: AccessDecisionKind
  /** The reason of the service. It is never given to the caller. */
  reason: string
  /** True when the decision was served from the cache. */
  cached: boolean
  /**
   * True when the decision was served while the access service was not
   * reachable.
   *
   * A stale decision is the last decision the service took, served for a
   * bounded time after its lifetime was over. It is served only when it
   * allows the caller: the grace exists so that an outage of the service
   * does not take the traffic down, and a denial that is served instead of
   * an outage hides the outage from the operator.
   */
  stale: boolean
  /** The moment the decision was taken, in milliseconds. */
  decidedAt: number
}

/** The request of a decision. */
export interface AccessRequest {
  /** The subject of the caller. */
  subject: string
  /**
   * The identifier of the workspace.
   *
   * It is absent when the route asks the access service about itself and
   * names no workspace: the service then decides on the subject, the route
   * and the roles.
   */
  workspaceId?: string
  /** The route the request came in on. */
  routeId: string
  /** The roles of the caller. */
  roles?: string[]
}

/**
 * The reason of a denial, as the metric counts it.
 *
 * `missing_role` is not a decision of the gateway: Shuttle does not check
 * roles itself. It is reported when the access service denies a caller
 * because of a missing role. The reason of the service is not given to the
 * caller: it describes the policy of the platform and it is not the business
 * of the client.
 */
export type AuthFailureReason = 'unauthenticated' | 'missing_role' | 'access_denied'

/**
 * Maps the reason of a denial to the reason of the metric.
 *
 * The reason of the service is free text: only the two categories above are
 * counted, so the metric cannot grow without limit.
 */
export function authFailureReason(reason: string): AuthFailureReason {
  return /role/i.test(reason) ? 'missing_role' : 'access_denied'
}
