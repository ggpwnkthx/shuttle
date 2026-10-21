/**
 * The commands of the shared state in a Postgres server.
 *
 * The clients connect in the background: the first command after the start
 * of a process can be sent before the connection of the pool is
 * established. The decorator of this module retries the commands that
 * failed because the connection was not established yet. It is the only
 * implementation of that rule: the domains talk to the server, they do not
 * know how a connection is established.
 *
 * Every other error is passed on unchanged, so a server that is really down
 * is reported as such: the limiter fails open and the sessions fail closed.
 */

import { isConnectionError } from './client'

/** The commands the domains of the shared state use. */
export interface PostgresCommands {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

/**
 * Wraps a client with the retry of the commands that failed because the
 * connection was not established.
 */
export function withPostgresRetries<T extends PostgresCommands>(client: T, attempts = 3): T {
  const run = async <R>(command: () => Promise<R>): Promise<R> => {
    let lastError: unknown
    const total = Math.max(1, attempts)
    for (let attempt = 0; attempt < total; attempt++) {
      try {
        return await command()
      } catch (error) {
        if (!isConnectionError(error)) throw error
        lastError = error
        if (attempt < total - 1) {
          await sleep(25 * (attempt + 1))
        }
      }
    }
    throw lastError
  }

  // The client is wrapped, not copied: the commands the domains do not use
  // (the transactions, the closing of the pool) keep working.
  const proxy = new Proxy(client as unknown as Record<string | symbol, unknown>, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (text: string, params: readonly unknown[] = []) =>
          run(() =>
            (client.query as (t: string, p: readonly unknown[]) => Promise<unknown>)(text, params)
          )
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return proxy as T
}

/** The wait between two attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
