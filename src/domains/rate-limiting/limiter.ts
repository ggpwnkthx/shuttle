/**
 * The limiter of the requests of a caller.
 *
 * The gateway uses it to put a bound on the requests a single caller can
 * make. The windows are counted per key, the storage is bounded, so a flood
 * of keys cannot grow the memory of the process without limit.
 *
 * A deployment with more than one replica needs a limiter that is shared
 * between the replicas: a limiter that lives in the memory of a process
 * allows every replica its own budget, so the limit of the deployment is
 * the limit of one replica times the number of them. The Redis
 * implementation keeps the windows in a server every replica talks to.
 */

import { LRUCache } from 'lru-cache'
import { retryAfterMs, windowStart } from './policy'

/** The number of keys the in-process limiter keeps at the same time. */
export const MAX_TRACKED_KEYS = 10_000

/** The outcome of a check of a limiter. */
export interface RateLimitDecision {
  /** True when the request is allowed. */
  allowed: boolean
  /** The limit of the window. */
  limit: number
  /** The requests that are still allowed in this window. */
  remaining: number
  /** How long the caller has to wait, in milliseconds. */
  retryAfterMs: number
}

/**
 * The port of a limiter.
 *
 * The two implementations behave the same, they only differ in where the
 * windows are kept.
 */
export interface RequestLimiter {
  /** Counts a request and reports whether it is allowed. */
  check(key: string, now?: number): Promise<RateLimitDecision>
  /** Forgets the windows of a key. */
  reset(key: string): Promise<void>
  /** True when the limiter does not limit anything. */
  readonly disabled: boolean
}

/** The settings of a limiter. */
export interface RateLimiterOptions {
  /**
   * The number of requests that are allowed in a window.
   *
   * A limit of zero disables the limiter: every request is allowed.
   */
  max: number
  /** The length of the window, in milliseconds. */
  windowMs: number
}

/** A window of the in-process limiter. */
interface Window {
  startedAt: number
  count: number
}

/**
 * A fixed window rate limiter that lives in the memory of the process.
 *
 * It is the right one for a single node deployment and the one the tests
 * use. A deployment with more than one replica uses the Redis
 * implementation instead.
 */
export class MemoryRateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #windows: LRUCache<string, Window>

  constructor(options: RateLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.#windows = new LRUCache<string, Window>({
      max: MAX_TRACKED_KEYS,
      // The window is removed by the logic below, the ttl is a safety net.
      ttl: Math.max(this.windowMs * 2, 1_000),
    })
  }

  /** True when the limiter does not limit anything. */
  get disabled(): boolean {
    return this.max <= 0
  }

  /** The number of keys that are tracked at the same time. */
  get size(): number {
    return this.#windows.size
  }

  /**
   * Counts a request and reports whether it is allowed.
   *
   * A request that is over the limit is not counted, so a client that keeps
   * hammering does not push the window further away.
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
    // The window is fixed: it starts at a moment every replica can compute,
    // so the windows of two deployments are the same windows.
    const start = windowStart(now, this.windowMs)
    const window = this.#windows.get(key)
    if (!window || window.startedAt !== start) {
      this.#windows.set(key, { startedAt: start, count: 1 })
      return { allowed: true, limit: this.max, remaining: this.max - 1, retryAfterMs: 0 }
    }
    if (window.count >= this.max) {
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        retryAfterMs: retryAfterMs(now, this.windowMs),
      }
    }
    window.count += 1
    return { allowed: true, limit: this.max, remaining: this.max - window.count, retryAfterMs: 0 }
  }

  /** Forgets the windows of a key. */
  async reset(key: string): Promise<void> {
    this.#windows.delete(key)
  }
}

/** The window of a caller, as the memory limiter computes it. */
export { windowStart }
