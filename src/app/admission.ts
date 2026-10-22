/**
 * The admission of the requests.
 *
 * The cap of the exchanges bounds the phase of the proxying: the requests
 * that are talking to an upstream at the same time. The phase **before**
 * it was not bounded: the limits, the authentication and the decision of
 * the access service happen before the exchange, and a request that waits
 * for the access service holds the resources of the process for the whole
 * budget of the call — three seconds by default.
 *
 * That gap matters exactly when it hurts. A service that hangs does not
 * refuse the requests, it makes them **slow**, and the cap of the
 * exchanges never sees them because they never reach the exchange. The
 * number of requests that wait at the same time is bounded by the number
 * of sockets and by the memory of the process, and the operator who set
 * `SHUTTLE_MAX_CONCURRENT_REQUESTS` believes they bounded it.
 *
 * This controller bounds the phase of the admission. A request that does
 * not fit is refused **at once**, with the same answer as an overloaded
 * gateway: a refusal is faster than a wait, and a wait is what turns a
 * slow dependency into an outage of the deployment.
 *
 * The controller is in the application and not in a domain: the admission
 * is the order of the pipeline and the mapping of a refusal to an answer,
 * and both belong to the application.
 */

/** The settings of the admission. */
export interface AdmissionOptions {
  /**
   * The number of requests that may be inside the gateway at the same
   * time.
   *
   * A value of zero means "no limit".
   */
  max?: number
}

export class AdmissionController {
  #max: number
  /** The number of requests that are inside the gateway. */
  #active = 0

  constructor(options: AdmissionOptions = {}) {
    this.#max = options.max ?? 0
  }

  /** The maximum number of requests that may be inside the gateway. */
  get max(): number {
    return this.#max
  }

  /** The number of requests that are inside the gateway right now. */
  get activeCount(): number {
    return this.#active
  }

  /** Reports whether the admission is active. */
  get enabled(): boolean {
    return this.#max > 0
  }

  /**
   * Takes a slot of the admission.
   *
   * It returns the function that gives the slot back, or null when the
   * gateway is full. The function is **idempotent**: giving the slot back
   * twice does not make room for a request that does not exist.
   *
   * The requests are counted even when the admission is disabled, so the
   * count is the number of requests that are inside the gateway whatever
   * the limit is.
   */
  tryAcquire(): (() => void) | null {
    if (this.enabled && this.#active >= this.#max) return null
    this.#active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
    }
  }
}
