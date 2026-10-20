/**
 * The commands of the shared state.
 *
 * The clients of the runtime connect lazily: the first command after the
 * start of a process (and the first one after a reconnect) can be sent
 * before the handshake of the connection is done. The offline queue of the
 * client is disabled on purpose, so such a command fails right away.
 *
 * The decorator of this module retries the commands that failed because the
 * connection was not established yet. It is the only implementation of that
 * rule: the domains talk to the server, they do not know how a connection
 * is established.
 */

import { isConnectionError } from './client'

/** The commands the domains of the shared state use. */
export interface RedisCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  ping(): Promise<string>
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>
}

/**
 * Wraps a client with the retry of the commands that failed because the
 * connection was not established.
 *
 * Every other error is passed on unchanged, so a server that is really down
 * is reported as such: the limiter fails open and the sessions fail closed.
 */
export function withRetries<T extends RedisCommands>(client: T, attempts = 3): T {
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
  // (the keys of a pattern, the closing of the connection) keep working.
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'get') {
        return (key: string) => run(() => target.get(key))
      }
      if (property === 'set') {
        return (key: string, value: string, ...args: (string | number)[]) =>
          run(() => target.set(key, value, ...args))
      }
      if (property === 'del') {
        return (key: string) => run(() => target.del(key))
      }
      if (property === 'ping') {
        return () => run(() => target.ping())
      }
      if (property === 'eval') {
        return (script: string, numkeys: number, ...keysAndArgs: (string | number)[]) =>
          run(() => target.eval(script, numkeys, ...keysAndArgs))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The wait between two attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
