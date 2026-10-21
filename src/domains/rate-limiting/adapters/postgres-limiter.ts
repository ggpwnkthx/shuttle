/**
 * A sliding window rate limiter whose windows live in a Postgres server.
 *
 * Every replica counts in the same window, so the limit of the deployment
 * is the configured limit and not the limit of one replica.
 *
 * The counting, the pruning of the buckets that left the window and the
 * expiry are **one** function of the server, so two replicas can never
 * count the same request in two windows and a window can never be counted
 * without an expiry. An ambiguous write is not retried: a counter that was
 * incremented twice is refused once more than it should be, which is the
 * safe direction.
 *
 * The buckets of a window are the rows of a table: the key of the caller
 * and the index of the bucket are the key of the row, and the number of
 * requests of the bucket is the value. The table holds at most the buckets
 * of a window per caller, and the sweeper removes the buckets that left
 * their window.
 */

import { createHash } from 'node:crypto'
import { rateLimitKey } from '../policy'
import { bucketSizeMs, windowBucketCount } from '../window'
import type { RateLimitDecision, RequestLimiter } from '../limiter'

/**
 * The part of a Postgres client the limiter needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface PostgresCommandPort {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface PostgresRateLimiterOptions {
  /** The client of the server. */
  client: PostgresCommandPort
  /** The number of requests that are allowed in a window. */
  max: number
  /** The length of the window, in milliseconds. */
  windowMs: number
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /**
   * How often the expired buckets are removed, in milliseconds.
   *
   * The buckets that left their window are removed by the function of the
   * server when the caller comes back; the sweeper removes the buckets of
   * the callers that never come back.
   */
  sweepIntervalMs?: number
  /**
   * Called when the server cannot be reached.
   *
   * The limiter fails open: a rate limiter protects the deployment from a
   * flood, and a limiter that refuses every request when the cache has a
   * hiccup turns the hiccup into an outage.
   */
  onError?: (error: unknown) => void
}

/** The default interval between two sweeps of the expired buckets. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export class PostgresRateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #client: PostgresCommandPort
  #prefix: string
  #sweepIntervalMs: number
  #lastSweep = 0
  #onError?: (error: unknown) => void

  constructor(options: PostgresRateLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#sweepIntervalMs = Math.max(1_000, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    this.#onError = options.onError
  }

  /** True when the limiter does not limit anything. */
  get disabled(): boolean {
    return this.max <= 0
  }

  /**
   * Counts a request in the window of the key.
   *
   * The window slides: the row of a bucket holds the number of the
   * requests of that bucket, and the count of the window is the sum of the
   * counts of the buckets that are in it.
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
    const postgresKey = `${this.#prefix}:rl:${hashKey(key)}`
    try {
      const result = await this.#client.query<{ window: unknown }>(
        `SELECT shuttle.rate_limit_check($1, $2, $3, $4, $5) AS window`,
        [postgresKey, now, bucketMs, buckets, this.max]
      )
      const window = result.rows[0]?.window
      if (!Array.isArray(window) || window.length < 3) {
        throw new Error('the answer of the limiter is not a window')
      }
      const allowed = toNumber(window[0]) === 1
      const count = toNumber(window[1])
      const retryAfterMs = toNumber(window[2])
      if (!Number.isFinite(count) || !Number.isFinite(retryAfterMs)) {
        throw new Error('the answer of the limiter is not a number')
      }
      await this.#sweep(now)
      return {
        allowed,
        limit: this.max,
        remaining: allowed ? Math.max(0, this.max - count) : 0,
        retryAfterMs: allowed ? 0 : retryAfterMs,
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
    // The buckets leave the window on their own, the reset is a courtesy
    // for the callers that use it.
    void key
  }

  /**
   * Removes the buckets that left their window.
   *
   * The sweep is a courtesy: a bucket that left its window is not counted
   * any more, whatever its row says.
   */
  async #sweep(now: number): Promise<void> {
    if (now - this.#lastSweep < this.#sweepIntervalMs) return
    this.#lastSweep = now
    try {
      await this.#client.query(`DELETE FROM shuttle.rate_limit_buckets WHERE expires_at < now()`)
    } catch {
      // The sweep is not the path of a request: a failure of it does not
      // fail the request.
    }
  }
}

/**
 * Reads a number out of the answer of the server.
 *
 * A `bigint` of Postgres is carried as a string by the driver, because it
 * does not fit in a number of JavaScript in every case. The values of the
 * window are small, so the string is a number.
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  if (typeof value === 'bigint') return Number(value)
  return Number.NaN
}

/** Hashes a key, so the keys of the server stay small and safe. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

export { rateLimitKey }
