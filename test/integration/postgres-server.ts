/**
 * A Postgres server for the tests of the shared state.
 *
 * The tests run against a real server when `SHUTTLE_TEST_POSTGRES_URL`
 * names one, and against the in-process engine of PGlite otherwise. The
 * engine is the same Postgres: the functions, the advisory locks and the
 * transactions behave the same, so a test that passes here passes against a
 * server.
 *
 *   SHUTTLE_TEST_POSTGRES_URL=postgres://user:password@127.0.0.1:5432/shuttle bun test test/integration
 */

import { PGlite } from '@electric-sql/pglite'
import { Pool } from 'pg'
import { ensureSchema } from '../../src/platform/postgres'

/** The client the tests use: the port the adapters depend on. */
export interface PostgresTestServer {
  /** Runs a command and returns the rows it answered. */
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
  /** Runs the body in a transaction. */
  transaction<T>(
    body: (client: {
      query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
    }) => Promise<T>
  ): Promise<T>
  /** Closes the server. */
  close(): Promise<void>
  /** The engine the tests run against. */
  engine: 'postgres' | 'pglite'
}

/**
 * Starts the server the tests run against.
 *
 * The schema is built before the tests: it is the same bootstrap the
 * gateway runs when it is allowed to.
 */
export async function startPostgres(): Promise<PostgresTestServer> {
  const url = process.env.SHUTTLE_TEST_POSTGRES_URL
  const server = url ? await startServer(url) : await startEmbedded()
  await ensureSchema(server)
  return server
}

/** A real server, named by the environment. */
async function startServer(url: string): Promise<PostgresTestServer> {
  const pool = new Pool({ connectionString: url, max: 10 })
  const server: PostgresTestServer = {
    engine: 'postgres',
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      const result = await pool.query(text, params as unknown[])
      return { rows: result.rows as T[] }
    },
    transaction: async <T>(
      body: (client: {
        query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
      }) => Promise<T>
    ) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await body({
          query: async <R>(text: string, params: readonly unknown[] = []) => {
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
          // The connection is broken: the rollback is not possible.
        }
        throw error
      } finally {
        client.release()
      }
    },
    close: async () => {
      await pool.end()
    },
  }
  return server
}

/**
 * The in-process engine.
 *
 * It is the engine of Postgres itself, compiled to WebAssembly: the SQL of
 * the adapters is the SQL of a server, and a test that proves something
 * here proves it against a server too.
 */
async function startEmbedded(): Promise<PostgresTestServer> {
  const db = await PGlite.create()
  const server: PostgresTestServer = {
    engine: 'pglite',
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      const result = await db.query(text, params as never[])
      return { rows: result.rows as T[] }
    },
    // The engine has a single connection: a transaction is the body.
    transaction: async <T>(
      body: (client: {
        query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
      }) => Promise<T>
    ) => body(server),
    close: async () => {
      await db.close()
    },
  }
  return server
}
