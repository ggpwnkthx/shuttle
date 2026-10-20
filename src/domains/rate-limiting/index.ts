/**
 * The rate limiting domain.
 *
 * The domain owns the windows of the limiters, the scopes of the budgets
 * (the caller over all the routes, the caller on one route, the requests
 * that match no route and the attempts of a login) and the behaviour of the
 * limiters when the state they share cannot be reached.
 */

export { MAX_TRACKED_KEYS, MemoryRateLimiter } from './limiter'
export type { RateLimitDecision, RateLimiterOptions, RequestLimiter } from './limiter'

export { rateLimitKey, retryAfterMs, windowStart } from './policy'
export type { RateLimitKeyInput, RateLimitScope } from './policy'
