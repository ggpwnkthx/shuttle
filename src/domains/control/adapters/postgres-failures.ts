/**
 * The counter of the failures of the authentication of a Postgres server.
 *
 * The counter lives in the shared state, so the limit of the failed
 * authentications holds across the replicas of the control plane: a client
 * that guesses a token cannot spread its guesses over the replicas.
 *
 * The window is counted in buckets of a second, the way the window of the
 * limiters is: the count of an address is the number of its failures in
 * the last seconds, and the state of an address does not grow with its
 * traffic.
 */

import type { AuthFailureCounter } from '../service'

/**
 * The part of a Postgres client the counter needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface PostgresFailureCommands {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface PostgresFailureCounterOptions {
  /** The client of the server. */
  client: PostgresFailureCommands
}

/** The counter of the failures of the authentication of a Postgres server. */
export class PostgresAuthFailureCounter implements AuthFailureCounter {
  #client: PostgresFailureCommands

  constructor(options: PostgresFailureCounterOptions) {
    this.#client = options.client
  }

  async count(key: string, windowMs: number): Promise<number> {
    const since = Math.floor(Date.now() / 1000) - Math.ceil(windowMs / 1000)
    const result = await this.#client.query<{ total: string | number }>(
      `SELECT coalesce(sum(failures), 0)::bigint AS total
         FROM shuttle.control_failures
        WHERE key = $1 AND bucket >= $2`,
      [key, since]
    )
    return Number(result.rows[0]?.total ?? 0)
  }

  async record(key: string, windowMs: number): Promise<number> {
    const bucket = Math.floor(Date.now() / 1000)
    await this.#client.query(
      `INSERT INTO shuttle.control_failures (key, bucket, failures, expires_at)
       VALUES ($1, $2, 1, now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (key, bucket) DO UPDATE
          SET failures = shuttle.control_failures.failures + 1,
              expires_at = EXCLUDED.expires_at`,
      [key, bucket, Math.max(1, Math.floor(windowMs))]
    )
    return await this.count(key, windowMs)
  }
}
