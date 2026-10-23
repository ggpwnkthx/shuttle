/**
 * The limiter that counts in the process when the state the replicas share
 * cannot be reached.
 *
 * The limiter of a deployment with more than one replica keeps its windows
 * in a Redis server or in a Postgres server, so every replica counts in the
 * same window and the limit of the deployment is the limit of the
 * configuration. When that server cannot be reached, the limiter of the
 * shared state has no window to count the request in.
 *
 * The limiter of the shared state **fails open**: a hiccup of the server is
 * not an outage of the deployment, and a limiter that refuses every request
 * when the cache has a hiccup turns the hiccup into an outage. The price
 * of that choice is that the protection against a flood is gone for as
 * long as the server is down: a caller that is over its budget is allowed
 * until the server answers again.
 *
 * This wrapper is the third way, and the deployment chooses it:
 *
 * | Mode | What happens while the shared state cannot be reached |
 * | --- | --- |
 * | `open` | Everything is allowed. The behaviour of the releases before this one. |
 * | `local` | The request is counted in the window of the **process**. |
 * | `closed` | Every request is refused. |
 *
 * The mode `local` is the default. The window of the process is the window
 * of the configuration, so a replica enforces the budget of the deployment
 * for the callers it sees, and the flood is bounded by the number of the
 * replicas instead of being unbounded. The budget of a caller is spent
 * faster than it should be — the window of the process does not know about
 * the requests the other replicas counted — and the direction of the error
 * is the safe one: the caller is refused a little early.
 *
 * The degradation is **visible**: it is counted in
 * `shuttle_rate_limit_fallback_total` and it is written in the log, so an
 * operator sees that the limits of the deployment are not the limits that
 * are running.
 */

import { MemoryRateLimiter, type RateLimitDecision, type RequestLimiter } from './limiter'

/**
 * What the limiter does when the state the replicas share cannot be
 * reached.
 */
export type RateLimitFallbackMode = 'open' | 'local' | 'closed'

export interface FallbackRateLimiterOptions {
  /** The limiter that keeps its windows in the shared state. */
  shared: RequestLimiter
  /**
   * The limiter that keeps its windows in the process.
   *
   * It is only used in the mode `local`.
   */
  local?: RequestLimiter
  /** What happens while the shared state cannot be reached. */
  mode: RateLimitFallbackMode
  /**
   * The scope of the limiter.
   *
   * It is reported when the limiter degrades, so the operator sees which
   * budget is degraded and not only that something is.
   */
  scope?: string
  /**
   * Called when a request was counted in the process because the shared
   * state could not be reached.
   *
   * The scope of the limiter is reported.
   */
  onFallback?: (scope: string) => void
  /**
   * Called when the shared state answers again.
   *
   * The wrapper remembers that it was degraded, so the operator is told
   * once that the limits of the deployment are the limits that are running
   * again.
   */
  onRecovered?: () => void
  /**
   * Called when the shared state could not be reached.
   *
   * The error is the one the shared limiter reported.
   */
  onError?: (error: unknown) => void
}

/**
 * A limiter that degrades when the state the replicas share is not
 * reachable.
 *
 * The wrapper holds the policy of the degradation, and the shared limiter
 * holds the windows. The rule of the domain is that the core code decides
 * and the adapters carry: the shared limiter answers with the windows it
 * could read, and this wrapper decides what a window it could not read
 * means.
 */
export class FallbackRateLimiter implements RequestLimiter {
  readonly max: number
  readonly windowMs: number
  #shared: RequestLimiter
  #local: RequestLimiter
  #mode: RateLimitFallbackMode
  #scope: string
  #onFallback?: (scope: string) => void
  #onRecovered?: () => void
  #onError?: (error: unknown) => void
  /** True when the shared state could not be reached the last time. */
  #degraded = false

  constructor(options: FallbackRateLimiterOptions) {
    this.#shared = options.shared
    this.#mode = options.mode
    this.#scope = options.scope ?? 'unknown'
    this.max = options.shared.max
    this.windowMs = options.shared.windowMs
    this.#local =
      options.local ??
      new MemoryRateLimiter({ max: options.shared.max, windowMs: options.shared.windowMs })
    this.#onFallback = options.onFallback
    this.#onRecovered = options.onRecovered
    this.#onError = options.onError
  }

  /** True when the limiter does not limit anything. */
  get disabled(): boolean {
    return this.#shared.disabled
  }

  /** True when the shared state could not be reached the last time. */
  get degraded(): boolean {
    return this.#degraded
  }

  /**
   * Counts a request in the window of the key.
   *
   * The window of the shared state is the one that counts, as long as it
   * can be reached. When it cannot, the mode of the wrapper decides.
   */
  async check(key: string, now: number = Date.now()): Promise<RateLimitDecision> {
    let decision: RateLimitDecision
    try {
      decision = await this.#shared.check(key, now)
    } catch (error) {
      // The shared limiter swallows its failures and answers with a
      // degraded decision, so this is the path of a limiter that throws.
      // It is handled like a degraded decision, because it means the same
      // thing: the windows of the shared state were not read.
      this.#onError?.(error)
      decision = {
        allowed: true,
        limit: this.max,
        remaining: this.max,
        retryAfterMs: 0,
        degraded: true,
      }
    }
    if (!decision.degraded) {
      // The shared state answers again: the limits of the deployment are
      // the limits that are running again.
      if (this.#degraded) {
        this.#degraded = false
        this.#onRecovered?.()
      }
      return decision
    }
    this.#degraded = true
    this.#onFallback?.(this.#scope)
    switch (this.#mode) {
      case 'open':
        return decision
      case 'closed':
        return {
          allowed: false,
          limit: this.max,
          remaining: 0,
          // The caller is told to come back after the window of the
          // deployment: the shared state may answer by then.
          retryAfterMs: this.windowMs,
          degraded: true,
        }
      case 'local':
        // The window of the process counts the request. The decision of the
        // shared limiter is dropped: it knows nothing about the callers.
        return { ...(await this.#local.check(key, now)), degraded: true }
    }
  }

  /** Forgets the windows of a key. */
  async reset(key: string): Promise<void> {
    await this.#shared.reset(key)
    await this.#local.reset(key)
  }
}
