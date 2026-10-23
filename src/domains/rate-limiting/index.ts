/**
 * The rate limiting domain.
 *
 * The domain owns the windows of the limiters, the scopes of the budgets
 * (the caller over all the routes, the caller on one route, the requests
 * that match no route and the attempts of a login) and the behaviour of the
 * limiters when the state they share cannot be reached.
 */

export { MAX_TRACKED_KEYS, MemoryRateLimiter } from './limiter'
export type { RateLimitDecision, RequestLimiter } from './limiter'

export { FallbackRateLimiter } from './fallback'
export type { RateLimitFallbackMode } from './fallback'

export { rateLimitKey, TOTAL_RATE_LIMIT_KEY } from './policy'

export {
  MAX_WINDOW_BUCKETS,
  bucketIndex,
  bucketSizeMs,
  evaluateWindow,
  windowBucketCount,
} from './window'
