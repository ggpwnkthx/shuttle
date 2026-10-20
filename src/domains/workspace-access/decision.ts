/**
 * The decisions of the access service.
 *
 * A decision is explicit: the service says whether the caller may use the
 * workspace or not. A decision that cannot be read is a denial: the gateway
 * never lets a caller in because the service had a hiccup.
 */

/** A decision of the access service. */
export interface AccessDecision {
  /** True when the caller may use the workspace. */
  allow: boolean
  /** The reason of the service. It is never given to the caller. */
  reason: string
  /** True when the decision was served from the cache. */
  cached: boolean
  /** The moment the decision was taken, in milliseconds. */
  decidedAt: number
}

/** The request of a decision. */
export interface AccessRequest {
  /** The subject of the caller. */
  subject: string
  /** The identifier of the workspace. */
  workspaceId: string
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
