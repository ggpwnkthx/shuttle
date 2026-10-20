import type { Logger } from '../../log/logger'
import {
  DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  type CreateSessionInput,
  type SessionRecord,
  type SessionStore,
} from './types'
import {
  isExpired,
  newSessionRecord,
  parseSessionRecord,
  serializeSessionRecord,
  touchDue,
} from './record'
import { createRedisClient, runWithRetry } from '../../redis/client'

export interface RedisSessionStoreOptions {
  /** Connection URL, for example `rediss://:password@host:6379/0`. */
  url: string
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  ttlMs?: number
  /** Minimum delay between two expiry refreshes of the same session. */
  touchIntervalMs?: number
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** How long the client waits for the connection to be established. */
  connectionTimeoutMs?: number
  /**
   * How often a command is retried while the connection is not established.
   *
   * The client connects lazily: the first command after the start (and the
   * first one after a reconnect) can be sent before the handshake is done.
   * Without the retry a user that logs in right after a deployment is
   * refused, even though the store is perfectly reachable.
   */
  connectAttempts?: number
  logger?: Logger
  /** Used by the tests to inject a client. */
  client?: Bun.RedisClient
}

/**
 * Shared session store backed by a Redis compatible server.
 *
 * The Redis wire protocol is spoken by most managed caches (Amazon
 * ElastiCache, Google Cloud Memorystore, Azure Cache for Redis, Aiven,
 * Upstash and a Helm managed Redis on Kubernetes), so one implementation
 * covers every provider a deployment can offer.
 *
 * Keys:
 *   `<prefix>:s:<id>`   the session record, expires after the session TTL
 */
/**
 * The session store talks to Redis through the client of Bun, so the
 * commands are the ones a Redis server sees.
 */
export class RedisSessionStore implements SessionStore {
  #client: Bun.RedisClient
  #ownsClient: boolean
  #prefix: string
  #ttlMs: number
  #touchIntervalMs: number
  #connectAttempts: number
  #logger?: Logger
  #touched = new Map<string, number>()

  constructor(options: RedisSessionStoreOptions) {
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
    this.#touchIntervalMs = options.touchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS
    this.#connectAttempts = Math.max(1, options.connectAttempts ?? 3)
    this.#logger = options.logger
    if (options.client) {
      this.#client = options.client
      this.#ownsClient = false
    } else {
      this.#client = createRedisClient({
        url: options.url,
        tlsCa: options.tlsCa,
        connectionTimeoutMs: options.connectionTimeoutMs,
      })
      this.#ownsClient = true
    }
  }

  /**
   * Runs a command against the server.
   *
   * A command that is sent before the connection is established is retried
   * a couple of times: the store is reachable, the handshake is just not
   * finished yet. Every other error is passed on unchanged, so a store that
   * is really down is reported as such.
   */
  async #run<T>(command: () => Promise<T>): Promise<T> {
    return await runWithRetry(command, this.#connectAttempts)
  }

  get ttlMs(): number {
    return this.#ttlMs
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now()
    const ttl = input.ttlMs ?? this.#ttlMs
    const record = newSessionRecord(input, ttl, now)
    await this.#run(() =>
      this.#client.set(
        this.#sessionKey(record.id),
        serializeSessionRecord(record),
        'EX',
        this.#seconds(ttl)
      )
    )
    this.#touched.set(record.id, now)
    return record
  }

  async get(id: string | undefined): Promise<SessionRecord | null> {
    if (!id) return null
    const raw = await this.#run(() => this.#client.get(this.#sessionKey(id)))
    if (!raw) {
      // The session is gone: the key expired or was removed. The bookkeeping
      // of the touch interval is dropped with it, so the map does not grow
      // for every session the gateway ever saw.
      this.#touched.delete(id)
      return null
    }
    const record = parseSessionRecord(raw)
    if (!record) {
      await this.#destroy(id)
      return null
    }
    const now = Date.now()
    if (isExpired(record, now)) {
      await this.destroy(id)
      return null
    }
    await this.#maybeTouch(record, now)
    return record
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id) return
    await this.#destroy(id)
  }

  async ping(): Promise<boolean> {
    try {
      await this.#run(() => this.#client.ping())
      return true
    } catch (error) {
      this.#logger?.warn('the session store is not reachable', { error })
      return false
    }
  }

  async close(): Promise<void> {
    this.#touched.clear()
    if (this.#ownsClient) this.#client.close()
  }

  #sessionKey(id: string): string {
    return `${this.#prefix}:s:${id}`
  }

  async #destroy(id: string): Promise<void> {
    await this.#run(() => this.#client.del(this.#sessionKey(id)))
    this.#touched.delete(id)
  }

  #seconds(ms: number): number {
    return Math.max(1, Math.ceil(ms / 1000))
  }

  async #maybeTouch(record: SessionRecord, now: number): Promise<void> {
    if (!touchDue(this.#touched.get(record.id), now, this.#touchIntervalMs)) return
    record.expiresAt = now + this.#ttlMs
    await this.#run(() =>
      this.#client.set(
        this.#sessionKey(record.id),
        serializeSessionRecord(record),
        'EX',
        this.#seconds(this.#ttlMs)
      )
    )
    this.#touched.set(record.id, now)
  }
}
