/**
 * The reservations of the websocket connections.
 *
 * The number of open connections is bounded, so a caller cannot open
 * connections until the process runs out of memory. The handshakes that are
 * in flight count as connections: a caller that opens many connections and
 * never finishes the handshake must not be able to use more resources than
 * a caller with open connections.
 */

export interface ReservationOptions {
  /** The number of connections that may be open at the same time. 0 is unlimited. */
  maxConnections: number
}

export class ReservationManager {
  readonly maxConnections: number
  /** The connections that are open. */
  #connections = 0
  /** The handshakes that are in flight. */
  #pending = 0

  constructor(options: ReservationOptions) {
    this.maxConnections = options.maxConnections
  }

  /** The number of connections that occupy a slot. */
  get connectionCount(): number {
    return this.#connections + this.#pending
  }

  /** The number of connections that are open. */
  get openCount(): number {
    return this.#connections
  }

  /** The number of handshakes that are in flight. */
  get pendingCount(): number {
    return this.#pending
  }

  /**
   * Reserves a slot for a connection that is about to be established.
   *
   * It returns false when the limit is reached. A limit of zero means "no
   * limit".
   */
  reserve(): boolean {
    if (this.maxConnections > 0 && this.connectionCount >= this.maxConnections) return false
    this.#pending += 1
    return true
  }

  /** Gives the slot of a handshake back, when the handshake did not happen. */
  releasePending(): void {
    if (this.#pending > 0) this.#pending -= 1
  }

  /** Turns the reservation of a handshake into the slot of a connection. */
  promote(): void {
    if (this.#pending > 0) this.#pending -= 1
    this.#connections += 1
  }

  /** Gives the slot of a connection back. */
  release(): void {
    if (this.#connections > 0) this.#connections -= 1
  }
}
