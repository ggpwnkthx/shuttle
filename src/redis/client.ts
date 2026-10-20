import type { Logger } from '../log/logger'

/**
 * The plumbing of the Redis connections.
 *
 * The gateway talks to a Redis compatible server for two things: the
 * sessions, and the state that is shared between the replicas (the rate
 * limits and the cached access decisions). Both use the same connection
 * settings, so the plumbing lives here.
 *
 * The wire protocol is the one of Redis, so one implementation covers every
 * managed cache (Amazon ElastiCache, Google Cloud Memorystore, Azure Cache
 * for Redis, Aiven, Upstash and a Helm managed Redis on Kubernetes).
 */

/** Reports whether a url names a Redis server. */
export function isRedisUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.startsWith('redis://') || url.startsWith('rediss://')
}

export interface RedisClientOptions {
  /** Connection URL, for example `rediss://:password@host:6379/0`. */
  url: string
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** How long the client waits for the connection to be established. */
  connectionTimeoutMs?: number
  logger?: Logger
}

/**
 * Creates a client of a Redis server.
 *
 * The offline queue of the client is disabled on purpose: a command that
 * is sent before the handshake is done fails right away instead of waiting
 * in a queue that nobody drains. The gateway denies the caller when the
 * store is down, it does not pile up requests.
 */
export function createRedisClient(options: RedisClientOptions): Bun.RedisClient {
  return new Bun.RedisClient(options.url, {
    enableOfflineQueue: false,
    autoReconnect: true,
    connectionTimeout: options.connectionTimeoutMs ?? 5_000,
    tls: options.tlsCa ? { ca: options.tlsCa } : options.url.startsWith('rediss://'),
  })
}

/**
 * Reports whether an error is the symptom of a connection that is not
 * established yet.
 */
export function isConnectionError(error: unknown): boolean {
  if (!error) return false
  const code = (error as { code?: string }).code
  if (code === 'ERR_REDIS_CONNECTION_CLOSED') return true
  const message = error instanceof Error ? error.message : String(error)
  return /connection is closed|not connected|ECONNREFUSED|socket closed/i.test(message)
}

/**
 * Runs a command against the server.
 *
 * A command that is sent before the connection is established is retried a
 * couple of times: the store is reachable, the handshake is just not
 * finished yet. Every other error is passed on unchanged, so a store that
 * is really down is reported as such.
 */
export async function runWithRetry<T>(
  command: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      return await command()
    } catch (error) {
      if (!isConnectionError(error)) throw error
      lastError = error
      if (attempt < attempts - 1) {
        await Bun.sleep(25 * (attempt + 1))
      }
    }
  }
  throw lastError
}
