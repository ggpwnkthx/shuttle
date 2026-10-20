/**
 * The adapters of the rate limiting domain.
 *
 * The composition root uses them to build the limiters of a deployment. The
 * domain itself knows nothing about them.
 */

export { COUNT_SCRIPT, RedisRateLimiter } from './redis-limiter'
export type { RedisCommandPort, RedisRateLimiterOptions } from './redis-limiter'
