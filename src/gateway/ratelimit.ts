import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { runWithRetry } from '../redis/client'

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

export interface RateLimiterOptions {
  /**
   * The number of requests that are allowed in a window.
   *
   * A limit of zero disables the limiter: every request is allowed.
   */
  max: number
  /** The length of the window, in milliseconds. */
  windowMs: number
  /** The number of keys that are tracked at the same time. */
  maxEntries?: number
}

interface Window {
  startedAt: number
  count: number
}

/**
 * A limiter of the requests of a caller.
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

/**
 * A fixed window rate limiter that lives in the memory of the process.
 *
 * It is the right one for a single node deployment and the one the tests
 * use. A deployment with more than one replica uses the Redis
 * implementation instead.
 */
export class RateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #windows: LRUCache<string, Window>

  constructor(options: RateLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.#windows = new LRUCache<string, Window>({
      max: options.maxEntries ?? 10_000,
      // The window is removed by the logic below, the ttl is a safety net.
      ttl: Math.max(this.windowMs * 2, 1_000),
    })
  }

  /** True when the limiter does not limit anything. */
  get disabled(): boolean {
    return this.max <= 0
  }

  /**
   * Counts a request and reports whether it is allowed.
   *
   * A request that is over the limit is not counted, so a client that keeps
   * hammering does not push the window further away.
   */
  async check(key: string, now: number = Date.now()): Promise<RateLimitDecision> {
    if (this.disabled) {
      return { allowed: true, limit: this.max, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 }
    }
    const window = this.#windows.get(key)
    if (!window || now - window.startedAt >= this.windowMs) {
      this.#windows.set(key, { startedAt: now, count: 1 })
      return {
        allowed: true,
        limit: this.max,
        remaining: this.max - 1,
        retryAfterMs: 0,
      }
    }
    if (window.count >= this.max) {
      const retryAfterMs = Math.max(0, window.startedAt + this.windowMs - now)
      return { allowed: false, limit: this.max, remaining: 0, retryAfterMs }
    }
    window.count += 1
    return {
      allowed: true,
      limit: this.max,
      remaining: this.max - window.count,
      retryAfterMs: 0,
    }
  }

  /** Forgets the windows of a key. */
  async reset(key: string): Promise<void> {
    this.#windows.delete(key)
  }
}

export interface RedisRateLimiterOptions extends RateLimiterOptions {
  client: Bun.RedisClient
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /** How often a command is retried while the connection is not ready. */
  connectAttempts?: number
  /**
   * Called when the server cannot be reached.
   *
   * The limiter fails open: a rate limiter protects the deployment from a
   * flood, and a limiter that refuses every request when the cache has a
   * hiccup turns the hiccup into an outage.
   */
  onError?: (error: unknown) => void
}

/**
 * A fixed window rate limiter whose windows live in a Redis server.
 *
 * Every replica counts in the same window, so the limit of the deployment
 * is the configured limit and not the limit of one replica.
 */
export class RedisRateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #client: Bun.RedisClient
  #prefix: string
  #connectAttempts: number
  #onError?: (error: unknown) => void

  constructor(options: RedisRateLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#connectAttempts = Math.max(1, options.connectAttempts ?? 3)
    this.#onError = options.onError
  }

  get disabled(): boolean {
    return this.max <= 0
  }

  /**
   * Counts a request in the window of the key.
   *
   * The key of the window contains the moment the window started, so a new
   * window is a new key and the old one expires on its own. The count is
   * atomic, the expiry is set on every call, so the key of a window never
   * outlives the window by more than the grace period.
   */
  async check(key: string, now: number = Date.now()): Promise<RateLimitDecision> {
    if (this.disabled) {
      return { allowed: true, limit: this.max, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 }
    }
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs
    const redisKey = `${this.#prefix}:rl:${hashKey(key)}:${windowStart}`
    // The key outlives the window a little, so a request that arrives at
    // the end of the window still finds its window.
    const ttlMs = this.windowMs + Math.floor(this.windowMs / 2)
    try {
      const count = await runWithRetry(async () => {
        const value = await this.#client.incr(redisKey)
        await this.#client.pexpire(redisKey, ttlMs)
        return Number(value)
      }, this.#connectAttempts)
      const allowed = count <= this.max
      return {
        allowed,
        limit: this.max,
        remaining: Math.max(0, this.max - count),
        retryAfterMs: allowed ? 0 : Math.max(0, windowStart + this.windowMs - now),
      }
    } catch (error) {
      // The limiter fails open: the protection against a flood is worth
      // less than the availability of the gateway.
      this.#onError?.(error)
      return { allowed: true, limit: this.max, remaining: this.max, retryAfterMs: 0 }
    }
  }

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
