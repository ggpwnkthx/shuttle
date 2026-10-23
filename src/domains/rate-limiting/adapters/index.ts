/**
 * The adapters of the rate limiting domain.
 *
 * The composition root uses them to build the limiters of a deployment. The
 * domain itself knows nothing about them.
 */

export { RedisRateLimiter, WINDOW_SCRIPT } from './redis-limiter'

export { PostgresRateLimiter } from './postgres-limiter'
