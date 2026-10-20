/**
 * The policy of the limiters.
 *
 * The windows are fixed: a window starts at a moment that every replica can
 * compute and it lasts a configured number of milliseconds. The keys of the
 * windows are built here, so the scopes of the limiters cannot drift apart.
 */

/** The scopes of the limiters. */
export type RateLimitScope = 'global' | 'route' | 'unmatched' | 'login'

/** The input of the key of a window. */
export interface RateLimitKeyInput {
  /** The address of the caller. */
  clientIp: string
  /** The id of the route, for the scope of a route. */
  routeId?: string
}

/**
 * The key of the window of a caller.
 *
 * The scopes are kept apart: the budget of a caller over all the routes is
 * not the budget of a caller on one route, and the requests that match no
 * route are counted in a bucket of their own.
 */
export function rateLimitKey(scope: RateLimitScope, input: RateLimitKeyInput): string {
  switch (scope) {
    case 'global':
      return `caller:${input.clientIp}`
    case 'route':
      return `route:${input.routeId ?? 'unknown'}:${input.clientIp}`
    case 'unmatched':
      return `none:${input.clientIp}`
    case 'login':
      return input.clientIp
  }
}

/**
 * The moment a window started.
 *
 * Every replica computes the same moment for the same clock, so the windows
 * of the replicas of a deployment are the same windows.
 */
export function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs
}

/**
 * The number of milliseconds a caller has to wait before the window is over.
 *
 * The time that is left is the time that is really left: a caller that is
 * refused at the beginning of a window waits almost the whole window, a
 * caller that is refused at its end waits a moment.
 */
export function retryAfterMs(now: number, windowMs: number): number {
  return Math.max(0, windowStart(now, windowMs) + windowMs - now)
}
