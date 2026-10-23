/**
 * A sliding window rate limiter whose windows live in a Redis server.
 *
 * Every replica counts in the same window, so the limit of the deployment is
 * the configured limit and not the limit of one replica.
 *
 * The counting, the pruning of the buckets that left the window and the
 * expiry are **one** operation: a script of the server does all of it, so
 * two replicas can never count the same request in two windows and a window
 * can never be counted without an expiry. An ambiguous write is not
 * retried: a counter that was incremented twice is refused once more than
 * it should be, which is the safe direction.
 *
 * The buckets of a window are the fields of a hash: the index of the bucket
 * is the field and the number of requests of the bucket is the value. The
 * hash holds at most the buckets of a window, and the expiry of the key
 * removes it when the caller is gone.
 */

import { createHash } from 'node:crypto'
import { rateLimitKey } from '../policy'
import { bucketSizeMs, windowBucketCount } from '../window'
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
 * The script that counts a request in the window of a key.
 *
 * It returns three values: whether the request is allowed, the number of
 * requests in the window and the number of milliseconds the caller has to
 * wait when it is refused.
 *
 * The buckets that left the window are removed first, so the count is the
 * count of the last `windowMs` milliseconds. A request that is over the
 * limit is not counted, so a client that keeps hammering does not push the
 * window further away.
 */
export const WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local bucket = tonumber(ARGV[2])
local buckets = tonumber(ARGV[3])
local max = tonumber(ARGV[4])
local current = math.floor(now / bucket)
local oldest = current - buckets + 1

-- The buckets that left the window are forgotten.
local fields = redis.call('HKEYS', key)
for i = 1, #fields do
  if tonumber(fields[i]) < oldest then
    redis.call('HDEL', key, fields[i])
  end
end

-- The buckets of the window, in the order of their index.
local all = redis.call('HGETALL', key)
local entries = {}
for i = 1, #all, 2 do
  local index = tonumber(all[i])
  if index >= oldest then
    entries[#entries + 1] = { index, tonumber(all[i + 1]) }
  end
end
table.sort(entries, function(left, right) return left[1] < right[1] end)

local total = 0
for i = 1, #entries do
  total = total + entries[i][2]
end

if total >= max then
  -- The caller waits for the oldest requests of the window to leave it.
  local needed = total - (max - 1)
  local prefix = 0
  local retry = (current + buckets) * bucket - now
  for i = 1, #entries do
    if prefix + entries[i][2] >= needed then
      retry = (entries[i][1] + buckets) * bucket - now
      break
    end
    prefix = prefix + entries[i][2]
  end
  return {0, total, retry}
end

redis.call('HINCRBY', key, tostring(current), 1)
redis.call('PEXPIRE', key, bucket * buckets * 2)
return {1, total + 1, 0}
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
   * The window slides: the key holds the buckets of the last `windowMs`
   * milliseconds, and the count of the window is the sum of their counts.
   * The key does not carry the moment of the window: the buckets do.
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
    const bucketMs = bucketSizeMs(this.windowMs)
    const buckets = windowBucketCount(this.windowMs, bucketMs)
    const redisKey = `${this.#prefix}:rl:${hashKey(key)}`
    try {
      const result = await this.#client.eval(
        WINDOW_SCRIPT,
        1,
        redisKey,
        now,
        bucketMs,
        buckets,
        this.max
      )
      if (!Array.isArray(result) || result.length < 3) {
        throw new Error('the answer of the limiter is not a window')
      }
      const allowed = Number(result[0]) === 1
      const count = Number(result[1])
      const retryAfterMs = Number(result[2])
      if (!Number.isFinite(count) || !Number.isFinite(retryAfterMs)) {
        throw new Error('the answer of the limiter is not a number')
      }
      return {
        allowed,
        limit: this.max,
        remaining: allowed ? Math.max(0, this.max - count) : 0,
        retryAfterMs: allowed ? 0 : retryAfterMs,
      }
    } catch (error) {
      // The limiter fails open: the protection against a flood is worth
      // less than the availability of the gateway. The decision is marked
      // as degraded, so the wrapper of the limiter knows that the windows
      // of the shared state could not be read and that it may count the
      // request in the process.
      this.#onError?.(error)
      return {
        allowed: true,
        limit: this.max,
        remaining: this.max,
        retryAfterMs: 0,
        degraded: true,
      }
    }
  }

  /** Forgets the windows of a key. */
  async reset(key: string): Promise<void> {
    // The buckets leave the window on their own, the reset is a courtesy
    // for the callers that use it.
    void key
  }
}

/** Hashes a key, so the keys of the server stay small and safe. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

export { rateLimitKey }
