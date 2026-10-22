/**
 * The health of the access service.
 *
 * The access service is a dependency of the deployment and it is on the
 * path of every request of a route that names a workspace. A service that
 * is down therefore does not only refuse the requests: it makes them
 * **slow**, because every request waits for the budget of the call before
 * it is answered.
 *
 * That is the failure the breaker closes. Without it, an outage of the
 * access service means one call per request, each of them waiting for the
 * whole timeout of the client, and the traffic of the deployment piles up
 * behind it. The dependency being down makes the gateway slower, and the
 * slower gateway falls further behind: the outage amplifies itself.
 *
 * The breaker remembers that the service failed and it stops calling it
 * for a while. The requests that arrive in the meantime are answered at
 * once, with the unavailability of the service, instead of waiting for a
 * timeout that is going to expire anyway.
 *
 * Two properties matter and they are the reason the breaker may sit on the
 * path of every request:
 *
 * 1. **The breaker can only make the gateway more restrictive.** It never
 *    lets a caller in: it answers the unavailability of the service, which
 *    is a refusal. A breaker that could grant access would be a hole; this
 *    one cannot be one.
 * 2. **The breaker is passive.** It learns from the failures the gateway
 *    observes and it never probes the service: a probe is a request of its
 *    own, and a probe needs an endpoint, a timeout and an interval. The
 *    cooldown is the only clock it uses.
 *
 * The state is **per process**, like the breaker of the upstreams: a
 * counter of failures does not deserve a round trip on the path of every
 * request. A replica that did not see the failures calls the service while
 * the others do not, and it learns from its own failures in the same way.
 */

/** The settings of the breaker of the access service. */
export interface AccessBreakerOptions {
  /**
   * The number of consecutive failures before the service is not called
   * any more.
   *
   * A value of zero disables the breaker: the service is called on every
   * request, and a request waits for the whole budget of the call when the
   * service does not answer.
   */
  failures?: number
  /**
   * How long the service is not called after it failed, in milliseconds.
   *
   * The service is tried again when the cooldown is over. The first call
   * after the cooldown is a **probe**: it is allowed alone, and it decides
   * whether the service is healthy again.
   */
  cooldownMs?: number
  /** Called when a call of the service failed. */
  onFailure?: () => void
  /** Called when the service is not called any more. */
  onOpen?: () => void
  /** Called when the service answered again. */
  onRecovery?: () => void
}

/** The state of the breaker. */
export type AccessBreakerState = 'closed' | 'open' | 'half-open'

/** The default number of failures before the service is not called. */
export const DEFAULT_ACCESS_BREAKER_FAILURES = 5

/** The default cooldown of the service, in milliseconds. */
export const DEFAULT_ACCESS_BREAKER_COOLDOWN_MS = 5_000

export class AccessBreaker {
  /** The number of failures that happened one after the other. */
  #failures = 0
  #threshold: number
  #cooldownMs: number
  #onFailure?: () => void
  #onOpen?: () => void
  #onRecovery?: () => void
  /** The moment the service is tried again, when it is not called. */
  #openUntil = 0
  /** The state of the breaker. */
  #state: AccessBreakerState = 'closed'
  /** True while the probe after a cooldown is in flight. */
  #probing = false

  constructor(options: AccessBreakerOptions = {}) {
    this.#threshold = options.failures ?? DEFAULT_ACCESS_BREAKER_FAILURES
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_ACCESS_BREAKER_COOLDOWN_MS
    this.#onFailure = options.onFailure
    this.#onOpen = options.onOpen
    this.#onRecovery = options.onRecovery
  }

  /** The number of failures before the service is not called any more. */
  get failureThreshold(): number {
    return this.#threshold
  }

  /** How long the service is not called after it failed, in milliseconds. */
  get cooldownMs(): number {
    return this.#cooldownMs
  }

  /** Reports whether the breaker is active. */
  get enabled(): boolean {
    return this.#threshold > 0
  }

  /** The state of the breaker. */
  get state(): AccessBreakerState {
    return this.#state
  }

  /**
   * Reports whether the service may be called right now.
   *
   * When the cooldown is over, the breaker is **half open**: one call is
   * allowed and it decides whether the service is healthy again. The other
   * requests that arrive in the meantime are answered at once, with the
   * unavailability of the service: they wait for a probe that is already
   * in flight, and the wait would be as long as the wait of the probe.
   */
  allowCall(now: number = Date.now()): boolean {
    if (!this.enabled) return true
    if (this.#state === 'closed') return true
    if (this.#state === 'open') {
      if (now < this.#openUntil) return false
      // The cooldown is over: the breaker is half open and one probe is
      // allowed.
      this.#state = 'half-open'
      this.#probing = false
    }
    if (this.#probing) return false
    this.#probing = true
    return true
  }

  /**
   * Records a failure of the service.
   *
   * The failures are consecutive: a success resets the counter. A failure
   * of the probe after a cooldown opens the breaker again at once: the
   * service was just asked and it did not answer.
   */
  reportFailure(now: number = Date.now()): void {
    if (!this.enabled) return
    this.#onFailure?.()
    const wasProbing = this.#probing
    this.#probing = false
    if (wasProbing) {
      this.#open(now)
      return
    }
    this.#failures += 1
    if (this.#failures >= this.#threshold) {
      this.#failures = 0
      this.#open(now)
    }
  }

  /** Records a success of the service: it is called again right away. */
  reportSuccess(): void {
    if (!this.enabled) return
    const wasOpen = this.#state !== 'closed'
    this.#failures = 0
    this.#probing = false
    this.#state = 'closed'
    this.#openUntil = 0
    if (wasOpen) this.#onRecovery?.()
  }

  /** Forgets the state of the breaker. */
  reset(): void {
    this.#failures = 0
    this.#probing = false
    this.#state = 'closed'
    this.#openUntil = 0
  }

  /** Opens the breaker: the service is not called until the cooldown. */
  #open(now: number): void {
    this.#state = 'open'
    this.#openUntil = now + this.#cooldownMs
    this.#onOpen?.()
  }
}
