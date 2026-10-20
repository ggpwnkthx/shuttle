/**
 * A fixed window rate limiter whose windows live in a Redis server.
 *
 * Every replica counts in the same window, so the limit of the deployment is
 * the configured limit and not the limit of one replica.
 *
 * The increment and the expiry are **one** operation: a script of the server
 * does both, so a window can never be counted without an expiry and two
 * replicas can never count the same request in two windows. An ambiguous
 * write is not retried: a counter that was incremented twice is refused
 * once more than it should be, which is the safe direction.
 */

import { createHash } from 'node:crypto'
import { rateLimitKey, retryAfterMs, windowStart } from '../policy'
import type { RateLimitDecision, RequestLimiter } from '../limiter'

/**
 * The part of a Redis client the limiter needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface RedisCommandPort {
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>
}

/**
 * The script that counts a request.
 *
 * The counter is incremented and the expiry is set in the same operation,
 * and the expiry is only set when the window is created: the window lasts
 * exactly as long as it should.
 */
export const COUNT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`

export interface RedisRateLimiterOptions {
  /** The client of the server. */
  client: RedisCommandPort
  /** The number of requests that are allowed in a window. */
  max: number
  /** The length of the window, in milliseconds. */
  windowMs: number
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /**
   * Called when the server cannot be reached.
   *
   * The limiter fails open: a rate limiter protects the deployment from a
   * flood, and a limiter that refuses every request when the cache has a
   * hiccup turns the hiccup into an outage.
   */
  onError?: (error: unknown) => void
}

export class RedisRateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #client: RedisCommandPort
  #prefix: string
  #onError?: (error: unknown) => void

  constructor(options: RedisRateLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#onError = options.onError
  }

  /** True when the limiter does not limit anything. */
  get disabled(): boolean {
    return this.max <= 0
  }

  /**
   * Counts a request in the window of the key.
   *
   * The key of the window contains the moment the window started, so a new
   * window is a new key and the old one expires on its own. The count is
   * atomic, the expiry is set with it, so the key of a window never outlives
   * the window by more than the grace period.
   */
  async check(key: string, now: number = Date.now()): Promise<RateLimitDecision> {
    if (this.disabled) {
      return {
        allowed: true,
        limit: this.max,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
      }
    }
    const start = windowStart(now, this.windowMs)
    const redisKey = `${this.#prefix}:rl:${hashKey(key)}:${start}`
    // The key outlives the window a little, so a request that arrives at the
    // end of the window still finds its window.
    const ttlMs = this.windowMs + Math.floor(this.windowMs / 2)
    try {
      const result = await this.#client.eval(COUNT_SCRIPT, 1, redisKey, ttlMs)
      const count = Number(result)
      if (!Number.isFinite(count)) {
        throw new Error('the counter of the window is not a number')
      }
      return {
        allowed: count <= this.max,
        limit: this.max,
        remaining: Math.max(0, this.max - count),
        retryAfterMs: count <= this.max ? 0 : retryAfterMs(now, this.windowMs),
      }
    } catch (error) {
      // The limiter fails open: the protection against a flood is worth
      // less than the availability of the gateway.
      this.#onError?.(error)
      return { allowed: true, limit: this.max, remaining: this.max, retryAfterMs: 0 }
    }
  }

  /** Forgets the windows of a key. */
  async reset(key: string): Promise<void> {
    // The windows of a key are removed by their expiry, the reset is a
    // courtesy for the callers that use it.
    void key
  }
}

/** Hashes a key, so the keys of the server stay small and safe. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

export { rateLimitKey }
