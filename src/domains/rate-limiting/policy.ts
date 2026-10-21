/**
 * The policy of the limiters.
 *
 * The keys of the windows are built here, so the scopes of the limiters
 * cannot drift apart. The window itself is described in [window.ts](window.ts):
 * it slides, and it is counted in buckets.
 */

/**
 * The scopes of the limiters.
 *
 * - `global`     the budget of a caller over all the routes
 * - `route`      the budget of a caller on one route
 * - `principal`  the budget of an authenticated caller on one route
 * - `unmatched`  the budget of a caller on the requests that match no route
 * - `login`      the budget of a caller on the login attempts
 */
export type RateLimitScope = 'global' | 'route' | 'principal' | 'unmatched' | 'login'

/**
 * The key of the window of the whole deployment.
 *
 * The scopes that are keyed by an address cannot bound a flood that spreads
 * over many addresses: every address gets its own budget. This key has no
 * address in it, so every request of the deployment is counted in the same
 * window.
 */
export const TOTAL_RATE_LIMIT_KEY = 'deployment:total'

/** The input of the key of a window. */
export interface RateLimitKeyInput {
  /**
   * The address of the caller.
   *
   * It is absent for the scopes that are not keyed by an address.
   */
  clientIp?: string
  /** The id of the route, for the scopes of a route. */
  routeId?: string
  /** The subject of the authenticated caller, for the scope of a principal. */
  subject?: string
}

/**
 * The key of the window of a caller.
 *
 * The scopes are kept apart: the budget of a caller over all the routes is
 * not the budget of a caller on one route, and the requests that match no
 * route are counted in a bucket of their own.
 */
export function rateLimitKey(scope: RateLimitScope, input: RateLimitKeyInput): string {
  const clientIp = input.clientIp ?? 'unknown'
  switch (scope) {
    case 'global':
      return `caller:${clientIp}`
    case 'route':
      return `route:${input.routeId ?? 'unknown'}:${clientIp}`
    case 'principal':
      return `principal:${input.routeId ?? 'unknown'}:${input.subject ?? 'unknown'}`
    case 'unmatched':
      return `none:${clientIp}`
    case 'login':
      return clientIp
  }
}
