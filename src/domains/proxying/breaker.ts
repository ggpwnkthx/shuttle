/**
 * The health of the upstreams of the routes.
 *
 * A route may name several upstreams, and the order of the list is the
 * order of the file. The failover of the route, though, only reaches the
 * second upstream when the request may be sent twice: a request that
 * changes the state of an upstream is sent to one upstream and to no other
 * (§11.4 of the specification).
 *
 * That leaves the traffic that matters most — the `POST` of an API — with
 * no failover at all: when the first upstream accepts the connection and
 * never answers, the request burns the whole budget of the route and the
 * second upstream is never reached.
 *
 * The breaker closes that gap **without** sending a request twice. It
 * remembers the upstreams that failed recently and it moves them to the
 * end of the list, so the request is sent to an upstream that answered
 * recently. The request is still sent once, to one upstream, and the rule
 * that a request that changes the state of an upstream is never sent twice
 * is untouched.
 *
 * The breaker is **passive**: it learns from the failures the gateway
 * observes and it never probes an upstream. A probe would be a request of
 * its own, and the deployment would have to decide what a healthy upstream
 * is — an endpoint, a timeout, an interval — and every one of those
 * settings is another thing that looks active but is not.
 *
 * The state is **per process**: every replica learns on its own, from the
 * traffic it handles. It is not shared, because the shared state is on the
 * path of every request and a counter of failures does not deserve a round
 * trip: a replica that did not see the failure sends its next requests to
 * the upstream that is down, and pays the budget of the route, the way it
 * paid it before the breaker existed.
 */

/** The settings of the breaker. */
export interface UpstreamBreakerOptions {
  /**
   * The number of consecutive failures before an upstream is skipped.
   *
   * A value of zero disables the breaker: the order of the list is always
   * the order of the file.
   */
  failures?: number
  /**
   * How long an upstream is skipped, in milliseconds.
   *
   * The upstream is tried again when the cooldown is over, even when it
   * failed in the meantime: the breaker never removes an upstream, it only
   * moves it to the end of the list.
   */
  cooldownMs?: number
  /** Called when an upstream fails: a connection that was refused, an attempt that ran out of time. */
  onFailure?: (url: string) => void
  /** Called when the breaker starts skipping an upstream. */
  onOpen?: (url: string) => void
  /** Called when an upstream that was skipped answers again. */
  onRecovery?: (url: string) => void
}

/** The order the upstreams of a route are tried in. */
export interface UpstreamOrder {
  /** The upstreams, in the order they are tried. */
  urls: string[]
  /** The upstreams that were moved to the end because they failed recently. */
  skipped: string[]
}

/** The default number of failures before an upstream is skipped. */
export const DEFAULT_BREAKER_FAILURES = 3

/** The default cooldown of a skipped upstream, in milliseconds. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000

/** The state of one upstream. */
interface BreakerState {
  /** The number of failures that happened one after the other. */
  failures: number
  /** The moment the upstream is tried again, when it is skipped. */
  openUntil: number
}

export class UpstreamBreaker {
  /** The state of the upstreams, by url. */
  #state = new Map<string, BreakerState>()
  #failures: number
  #cooldownMs: number
  #onFailure?: (url: string) => void
  #onOpen?: (url: string) => void
  #onRecovery?: (url: string) => void

  constructor(options: UpstreamBreakerOptions = {}) {
    this.#failures = options.failures ?? DEFAULT_BREAKER_FAILURES
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS
    this.#onFailure = options.onFailure
    this.#onOpen = options.onOpen
    this.#onRecovery = options.onRecovery
  }

  /** The number of failures before an upstream is skipped. */
  get failureThreshold(): number {
    return this.#failures
  }

  /** How long an upstream is skipped, in milliseconds. */
  get cooldownMs(): number {
    return this.#cooldownMs
  }

  /** Reports whether the breaker is active. */
  get enabled(): boolean {
    return this.#failures > 0
  }

  /** The number of upstreams the breaker knows about. */
  get size(): number {
    return this.#state.size
  }

  /**
   * Reports whether an upstream is skipped right now.
   *
   * A skipped upstream is not removed: it is tried again when its cooldown
   * is over, and when every upstream of a route is skipped, they are all
   * tried in the order of the file.
   */
  isOpen(url: string, now: number = Date.now()): boolean {
    if (!this.enabled) return false
    const state = this.#state.get(url)
    if (!state) return false
    return state.openUntil > now
  }

  /**
   * The order the upstreams of a route are tried in.
   *
   * The upstreams that are not skipped come first, in the order of the
   * list, and the skipped ones come after them, also in the order of the
   * list. The order of the file is the order of the upstreams: the breaker
   * only moves the ones that failed to the end.
   */
  order(urls: readonly string[], now: number = Date.now()): UpstreamOrder {
    if (!this.enabled || urls.length < 2) return { urls: [...urls], skipped: [] }
    const healthy: string[] = []
    const skipped: string[] = []
    for (const url of urls) {
      if (this.isOpen(url, now)) skipped.push(url)
      else healthy.push(url)
    }
    return { urls: [...healthy, ...skipped], skipped }
  }

  /**
   * Records a failure of an upstream.
   *
   * A failure is a connection that was refused, or an attempt that ran out
   * of its budget: both are facts about the upstream and not about the
   * request. The failures are consecutive: a success resets the counter.
   */
  reportFailure(url: string, now: number = Date.now()): void {
    if (!this.enabled) return
    this.#onFailure?.(url)
    const state = this.#state.get(url) ?? { failures: 0, openUntil: 0 }
    state.failures += 1
    if (state.failures >= this.#failures) {
      state.failures = 0
      state.openUntil = now + this.#cooldownMs
      this.#state.set(url, state)
      this.#onOpen?.(url)
      return
    }
    this.#state.set(url, state)
  }

  /** Records a success of an upstream: the upstream is tried first again. */
  reportSuccess(url: string): void {
    if (!this.enabled) return
    const state = this.#state.get(url)
    if (!state) return
    const wasOpen = state.openUntil > 0
    this.#state.delete(url)
    if (wasOpen) this.#onRecovery?.(url)
  }

  /** Forgets the state of every upstream. */
  reset(): void {
    this.#state.clear()
  }
}
