/**
 * The counter of the failures of the authentication of a Redis server.
 *
 * The counter lives in the shared state, so the limit of the failed
 * authentications holds across the replicas of the control plane: a client
 * that guesses a token cannot spread its guesses over the replicas.
 */

import { createHash } from 'node:crypto'
import type { AuthFailureCounter } from '../service'

/**
 * The part of a Redis client the counter needs.
 *
 * The domain does not know the client of the runtime: it knows the commands
 * it sends, and the platform builds a client that speaks them.
 */
export interface RedisFailureCommands {
  get(key: string): Promise<string | null>
  /** Grows a counter by one and returns its value. */
  incr(key: string): Promise<number>
  /** The lifetime of a key, in milliseconds. */
  pexpire(key: string, ms: number): Promise<number>
}

export interface RedisFailureCounterOptions {
  /** The client of the server. */
  client: RedisFailureCommands
  /** The prefix of the keys, the one of the state the counter lives in. */
  keyPrefix?: string
}

/** The counter of the failures of the authentication of a Redis server. */
export class RedisAuthFailureCounter implements AuthFailureCounter {
  #client: RedisFailureCommands
  #prefix: string

  constructor(options: RedisFailureCounterOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
  }

  async count(key: string, _windowMs: number): Promise<number> {
    const raw = await this.#client.get(this.#key(key))
    if (typeof raw !== 'string' || raw === '') return 0
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }

  async record(key: string, windowMs: number): Promise<number> {
    const count = await this.#client.incr(this.#key(key))
    // The window is refreshed with every failure: the counter of an
    // address that keeps guessing never expires.
    await this.#client.pexpire(this.#key(key), Math.max(1, Math.floor(windowMs)))
    return count
  }

  /** The key of the counter of an address. */
  #key(address: string): string {
    const digest = createHash('sha256').update(address).digest('hex').slice(0, 32)
    return `${this.#prefix}:control:failures:${digest}`
  }
}
