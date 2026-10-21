/**
 * The store of the sessions that lives in a Postgres server.
 *
 * The store is the counterpart of the one of Redis: the same contract, the
 * same behaviour, another server. The sessions are rows of a table and the
 * refresh of the expiry is **one** function of the server:
 *
 * - it reads the record and checks the maximum age of the session, and it
 *   removes the session when it is over;
 * - it refreshes the expiry only when the touch interval is over, so a busy
 *   caller is not written on every request, and the interval is the same on
 *   every replica;
 * - the new expiry never reaches beyond the maximum age of the session;
 * - a session that was deleted (a logout) is never recreated: the function
 *   only refreshes a session that it found.
 *
 * A function call of the server is a transaction, so the read, the
 * decision and the write happen without another session in between, the
 * way a script of Redis does.
 */

import {
  isPastIdleLifetime,
  isPastMaximumAge,
  newSessionRecord,
  parseSessionRecord,
  serializeSessionRecord,
  type CreateSessionInput,
  type SessionLifetime,
  type SessionRecord,
  type SessionStore,
} from '../session'

/**
 * The part of a Postgres client the store needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface PostgresSessionCommands {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface PostgresSessionStoreOptions extends Partial<SessionLifetime> {
  /** The client of the server. */
  client: PostgresSessionCommands
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /**
   * How often the expired sessions are removed, in milliseconds.
   *
   * The rows of the sessions that are never read again would stay in the
   * table for ever otherwise: a server that does not remove them has to
   * grow.
   */
  sweepIntervalMs?: number
}

/** The default interval between two sweeps of the expired sessions. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/**
 * The shared session store.
 *
 * There is exactly one behaviour when the store cannot be reached: the
 * request is denied. A gateway that mirrors the sessions in its own memory
 * would authenticate a caller that no other replica knows.
 */
export class PostgresSessionStore implements SessionStore {
  #client: PostgresSessionCommands
  #prefix: string
  #lifetime: SessionLifetime
  #sweepIntervalMs: number
  /** The moment of the last sweep. */
  #lastSweep = 0

  constructor(options: PostgresSessionStoreOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#lifetime = {
      ttlMs: options.ttlMs ?? 8 * 60 * 60_000,
      maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60_000,
      touchIntervalMs: options.touchIntervalMs ?? 60_000,
    }
    this.#sweepIntervalMs = Math.max(1_000, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
  }

  get ttlMs(): number {
    return this.#lifetime.ttlMs
  }

  get maxAgeMs(): number {
    return this.#lifetime.maxAgeMs
  }

  get touchIntervalMs(): number {
    return this.#lifetime.touchIntervalMs
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now()
    const record = newSessionRecord(input, this.#lifetime, now)
    const absolute = record.absoluteExpiresAt
    await this.#client.query(
      `INSERT INTO shuttle.sessions (id, record, expires_at, absolute_expires_at, updated_at)
       VALUES ($1, $2::jsonb, to_timestamp(($3 / 1000.0)::double precision), $4::timestamptz, now())`,
      [
        this.#sessionKey(record.id),
        serializeSessionRecord(record),
        record.expiresAt,
        absolute === undefined ? null : new Date(absolute).toISOString(),
      ]
    )
    return record
  }

  async get(id: string | undefined): Promise<SessionRecord | null> {
    if (!id) return null
    const now = Date.now()
    const result = await this.#client.query<{ record: string | null }>(
      `SELECT shuttle.session_touch($1, $2, $3, $4) AS record`,
      [this.#sessionKey(id), this.#lifetime.ttlMs, now, this.#lifetime.touchIntervalMs]
    )
    const raw = result.rows[0]?.record
    if (typeof raw !== 'string' || raw === '') return null
    const record = parseSessionRecord(raw, now)
    if (!record) {
      await this.destroy(id)
      return null
    }
    if (isPastMaximumAge(record, now) || isPastIdleLifetime(record, now)) {
      await this.destroy(id)
      return null
    }
    await this.#sweep(now)
    return record
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id) return
    await this.#client.query(`DELETE FROM shuttle.sessions WHERE id = $1`, [this.#sessionKey(id)])
  }

  async ping(): Promise<boolean> {
    try {
      // The readiness of the gateway is the readiness of its state: a
      // server that answers but that does not hold the schema yet is not
      // ready, because the sessions would fail closed.
      const result = await this.#client.query<{ present: boolean }>(
        `SELECT to_regclass('shuttle.sessions') IS NOT NULL AS present`
      )
      return result.rows[0]?.present === true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    // The client is owned by the runtime.
  }

  /**
   * Removes the sessions that are over.
   *
   * The sweep is a courtesy: a session that is over is refused by the
   * function of the server whether its row is there or not.
   */
  async #sweep(now: number): Promise<void> {
    if (now - this.#lastSweep < this.#sweepIntervalMs) return
    this.#lastSweep = now
    try {
      await this.#client.query(`DELETE FROM shuttle.sessions WHERE expires_at < now()`)
    } catch {
      // The sweep is not the path of a request: a failure of it does not
      // fail the request.
    }
  }

  /**
   * The key of a session.
   *
   * The prefix is part of the key, the way it is part of the key of Redis:
   * several environments can share one server.
   */
  #sessionKey(id: string): string {
    return `${this.#prefix}:s:${id}`
  }
}
