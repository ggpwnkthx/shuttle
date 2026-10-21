/**
 * The plumbing of the Postgres connections.
 *
 * The gateway talks to a Postgres server for the same three things it talks
 * to a Redis server for: the sessions, the rate limits and the cached
 * decisions. The two backends are interchangeable: the scheme of the url
 * picks one of them, and the deployment measures them side by side (see
 * `docs/capacity.md`).
 *
 * The client is the one of the `pg` package: it is the driver that the
 * managed Postgres services of every cloud speak to, and it is not tied to
 * the runtime of the gateway.
 *
 * Three properties of the client matter for the gateway:
 *
 * - the **pool** is bounded: a deployment has a limited number of
 *   connections to the database, and a gateway that opens one connection
 *   per request exhausts them;
 * - the connection is established in the **background**: a gateway that
 *   starts while the database is down stays up, reports that it is not
 *   ready, and becomes ready when the server answers;
 * - a command that cannot be sent fails **right away**: the offline queue
 *   of the Redis client stays disabled for the same reason, and the
 *   gateway denies the caller instead of piling up the requests.
 */

import { Pool, type PoolConfig, type PoolClient } from 'pg'

/** Reports whether an url names a Postgres server. */
export function isPostgresUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.startsWith('postgres://') || url.startsWith('postgresql://')
}

export interface PostgresClientOptions {
  /** Connection url, for example `postgres://user:password@host:5432/shuttle`. */
  url: string
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** The number of connections of the pool. */
  poolMax?: number
  /** How long the client waits for a connection of the pool. */
  connectionTimeoutMs?: number
  /** How long a statement of the gateway may run, in milliseconds. */
  statementTimeoutMs?: number
  /**
   * Whether the server waits for the disk before it answers.
   *
   * The state of the shared state is a protection and not a ledger: the
   * default is `off`, the same guarantee a Redis server gives without its
   * append only file.
   */
  synchronousCommit?: 'on' | 'off'
  /**
   * Called when the connection fails.
   *
   * It is called once per outage: the pool keeps trying to connect, and a
   * server that is down does not have to fill the log of the gateway.
   */
  onError?: (error: unknown) => void
}

/** The result of a command. */
export interface PostgresResult<T> {
  /** The rows the server answered. */
  rows: T[]
}

/**
 * The client of the shared state.
 *
 * The commands of the port of the domains are the ones of SQL, so the
 * domains do not know the client of the runtime.
 */
export class PostgresClient {
  #pool: Pool
  #closed = false
  /** True when the failure of the connection was already reported. */
  #reported = false
  #onError?: (error: unknown) => void
  /** True when the pool answered a command. */
  #ready = false
  /** The timer of the next attempt to connect. */
  #retryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Called after the connection is established.
   *
   * The schema of the shared state is built there: the statements are
   * idempotent, and they are applied again after a reconnection, so a
   * gateway that starts while the database is down builds the schema when
   * the database answers.
   */
  onConnect?: () => Promise<void>

  constructor(options: PostgresClientOptions) {
    this.#onError = options.onError
    const config: PoolConfig = {
      connectionString: options.url,
      max: Math.max(1, options.poolMax ?? 10),
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      // The pool does not wait forever for a connection: a gateway that
      // waits for a connection that does not come holds its requests and
      // its own memory.
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    }
    if (options.tlsCa) {
      // The certificate of the server is verified with the authority of
      // the deployment. A server whose certificate is not signed by it is
      // refused, the same way the client of a Redis server refuses it.
      config.ssl = { ca: options.tlsCa, rejectUnauthorized: true }
    }
    if (options.statementTimeoutMs && options.statementTimeoutMs > 0) {
      // A statement that runs forever holds a connection of the pool and
      // the row it locked. The gateway refuses the caller instead.
      config.options = `-c statement_timeout=${Math.floor(options.statementTimeoutMs)}`
    }
    if (options.synchronousCommit) {
      // The state of the shared state is a protection and not a ledger: the
      // server does not wait for the disk before it answers, the same
      // guarantee a Redis server gives without its append only file.
      config.options = `${config.options ? `${config.options} ` : ''}-c synchronous_commit=${options.synchronousCommit}`
    }
    this.#pool = new Pool(config)

    this.#pool.on('error', (error: unknown) => {
      if (this.#closed || this.#reported) return
      // The pool keeps trying to connect: the failure is reported once
      // per outage, and again when the connection is established.
      this.#reported = true
      this.#onError?.(error)
    })

    // The connection is established in the background: a gateway that
    // starts while the database is down stays up and becomes ready when
    // the server answers.
    void this.#connect()
  }

  /**
   * Opens a connection and closes it right away, to prove the server
   * answers.
   *
   * The attempt is repeated when it fails: a database that is down for a
   * while must not need a restart of the gateway to be used again.
   */
  async #connect(): Promise<void> {
    if (this.#closed) return
    try {
      const client = await this.#pool.connect()
      try {
        await client.query('SELECT 1')
        if (this.onConnect) await this.onConnect()
      } finally {
        client.release()
      }
      this.#ready = true
      this.#reported = false
    } catch (error) {
      this.#onError?.(error)
      this.#scheduleRetry()
    }
  }

  /** Schedules the next attempt to connect. */
  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#connect()
    }, 2_000)
    // The timer does not hold the process: the drain of the gateway closes
    // the client on its own.
    this.#retryTimer.unref?.()
  }

  /** Runs a command and returns the rows it answered. */
  async query<T>(text: string, params: readonly unknown[] = []): Promise<PostgresResult<T>> {
    if (this.#closed) {
      throw new Error('the client of the database is closed')
    }
    const result = await this.#pool.query(text, params as unknown[])
    return { rows: result.rows as T[] }
  }

  /**
   * Runs a command in a transaction.
   *
   * The transaction is committed when the body returns and rolled back when
   * it throws, so a command that fails never leaves a half written state
   * behind.
   */
  async transaction<T>(body: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new Error('the client of the database is closed')
    }
    const client: PoolClient = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const result = await body({
        query: async <R>(
          text: string,
          params: readonly unknown[] = []
        ): Promise<PostgresResult<R>> => {
          const outcome = await client.query(text, params as unknown[])
          return { rows: outcome.rows as R[] }
        },
      })
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection is broken: the rollback is not possible and the
        // client releases it in the `finally` below.
      }
      throw error
    } finally {
      client.release()
    }
  }

  /** Reports whether the server answers. */
  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1')
      this.#ready = true
      return true
    } catch {
      return false
    }
  }

  /** True when the pool has answered a command. */
  get ready(): boolean {
    return this.#ready
  }

  /** Closes the pool and waits for the connections to end. */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    try {
      await this.#pool.end()
    } catch {
      // The pool is already gone: the process is going away.
    }
  }
}

/** The part of the client a transaction sees. */
export interface PostgresQueryClient {
  query<T>(text: string, params?: readonly unknown[]): Promise<PostgresResult<T>>
}

/**
 * Creates a client of a Postgres server.
 *
 * The factory is the shape the composition root uses, the same way the
 * Redis one is.
 */
export function createPostgresClient(options: PostgresClientOptions): PostgresClient {
  return new PostgresClient(options)
}

/**
 * Reports whether an error is the symptom of a connection that is not
 * established yet.
 *
 * The codes are the ones of the server and of the socket: the connection
 * was refused, it was closed, the server is starting or it cannot accept
 * one more connection. Those errors are the ones a command may be retried
 * after; a syntax error is not one of them.
 */
export function isConnectionError(error: unknown): boolean {
  if (!error) return false
  const code = (error as { code?: string }).code
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    // 08xxx: the connection is broken or the server is not there.
    code === '08000' ||
    code === '08001' ||
    code === '08003' ||
    code === '08004' ||
    code === '08006' ||
    code === '08007' ||
    code === '08P01' ||
    // 57xxx: the server is shutting down or cannot accept a connection.
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    // 53xxx: the server is out of resources.
    code === '53300' ||
    code === '53400'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /timeout exceeded when trying to connect|connection terminated|connection ended|server closed the connection|could not connect|client has encountered a connection error|Connection terminated/i.test(
    message
  )
}
