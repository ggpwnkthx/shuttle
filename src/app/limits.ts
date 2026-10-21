/**
 * The budgets of a request.
 *
 * A request is counted in three windows: the budget of the deployment, the
 * budget of the caller over all the routes and the budget of the caller on
 * the route. The fourth one — the budget of the authenticated caller on the
 * route — is checked later, because it needs the subject of the caller.
 *
 * The three budgets are **independent**: they are counted in three
 * different windows and none of them changes the answer of another one.
 * They are therefore checked **at the same time**, so a request that
 * reaches a server that holds the state the replicas share pays one round
 * trip instead of three. The measurements of `docs/capacity.md` attribute
 * the cost of the shared state to the number of round trips, and this is
 * the round trip that is on the path of every request.
 *
 * The refusal that is reported is the first of the order of the
 * specification: the deployment, then the caller over all the routes, then
 * the caller on the route. All three windows are counted, even when one of
 * them refuses: the request was made, and the budget of the caller is spent
 * by the requests that were made.
 */

import type { RateLimitDecision, RequestLimiter } from '../domains/rate-limiting'

/** The scopes of the budgets of a request, in the order of the report. */
export type LimitScope = 'total' | 'global' | 'route'

/** The budgets of a request and the windows they are counted in. */
export interface LimitChecks {
  /** The budget of the deployment. */
  total: RequestLimiter
  /** The budget of the caller over all the routes. */
  global: RequestLimiter
  /** The budget of the caller on the route. */
  route: RequestLimiter
  /** The window of the budget of the deployment. */
  totalKey: string
  /** The window of the budget of the caller over all the routes. */
  globalKey: string
  /** The window of the budget of the caller on the route. */
  routeKey: string
}

/** The outcome of the budgets of a request. */
export interface LimitOutcome {
  /** The refusal, when one of the budgets is exhausted. */
  refusal: { scope: LimitScope; decision: RateLimitDecision } | null
}

/**
 * Counts a request in the three budgets of the specification.
 *
 * The refusal that is reported is the first of the order of the
 * specification, whatever order the answers arrive in.
 */
export async function checkLimits(checks: LimitChecks): Promise<LimitOutcome> {
  const [total, global, route] = await Promise.all([
    checks.total.check(checks.totalKey),
    checks.global.check(checks.globalKey),
    checks.route.check(checks.routeKey),
  ])

  if (!total.allowed) return { refusal: { scope: 'total', decision: total } }
  if (!global.allowed) return { refusal: { scope: 'global', decision: global } }
  if (!route.allowed) return { refusal: { scope: 'route', decision: route } }
  return { refusal: null }
}
