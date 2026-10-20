import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { runWithRetry } from '../redis/client'

/**
 * The cache of the access decisions.
 *
 * The access service is asked for every request of a caller that uses a
 * workspace. The decision is cached for a few seconds, so a busy gateway
 * does not ask the access service for every single request.
 *
 * The cache lives in the memory of the process by default. A deployment
 * with more than one replica uses the Redis implementation, so every replica
 * answers with the same decision.
 */

/** A decision of the access service, as it is cached. */
export interface CachedDecision {
  allow: boolean
  reason: string
  decidedAt: number
}

export interface DecisionCache {
  /** Returns the cached decision of a key, or null. */
  get(key: string): Promise<CachedDecision | null>
  /** Caches a decision for the given number of milliseconds. */
  set(key: string, decision: CachedDecision, ttlMs: number): Promise<void>
  /** Removes the cached decision of a key. */
  delete(key: string): Promise<void>
  /** Closes the cache. */
  close(): Promise<void>
}

/**
 * A cache that lives in the memory of the process.
 */
export class MemoryDecisionCache implements DecisionCache {
  #cache: LRUCache<string, CachedDecision>

  constructor(options: { maxEntries?: number } = {}) {
    this.#cache = new LRUCache<string, CachedDecision>({
      max: options.maxEntries ?? 1_000,
    })
  }

  async get(key: string): Promise<CachedDecision | null> {
    return this.#cache.get(key) ?? null
  }

  async set(key: string, decision: CachedDecision, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    this.#cache.set(key, decision, { ttl: ttlMs })
  }

  async delete(key: string): Promise<void> {
    this.#cache.delete(key)
  }

  async close(): Promise<void> {
    this.#cache.clear()
  }
}

export interface RedisDecisionCacheOptions {
  client: Bun.RedisClient
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /** How often a command is retried while the connection is not ready. */
  connectAttempts?: number
  /**
   * Called when the server cannot be reached.
   *
   * The cache fails open: a decision that is not cached is asked for again,
   * and the access service itself still decides. A cache that is not
   * available never changes the answer of a request.
   */
  onError?: (error: unknown) => void
}

/**
 * A cache whose decisions live in a Redis server.
 */
export class RedisDecisionCache implements DecisionCache {
  #client: Bun.RedisClient
  #prefix: string
  #connectAttempts: number
  #onError?: (error: unknown) => void

  constructor(options: RedisDecisionCacheOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#connectAttempts = Math.max(1, options.connectAttempts ?? 3)
    this.#onError = options.onError
  }

  async get(key: string): Promise<CachedDecision | null> {
    try {
      const raw = await runWithRetry(
        () => this.#client.get(this.#key(key)),
        this.#connectAttempts
      )
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<CachedDecision>
      if (typeof parsed.allow !== 'boolean') return null
      return {
        allow: parsed.allow,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        decidedAt: typeof parsed.decidedAt === 'number' ? parsed.decidedAt : Date.now(),
      }
    } catch (error) {
      this.#onError?.(error)
      return null
    }
  }

  async set(key: string, decision: CachedDecision, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    try {
      await runWithRetry(
        () =>
          this.#client.set(
            this.#key(key),
            JSON.stringify(decision),
            'PX',
            Math.max(1, Math.ceil(ttlMs))
          ),
        this.#connectAttempts
      )
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await runWithRetry(() => this.#client.del(this.#key(key)), this.#connectAttempts)
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async close(): Promise<void> {
    /* the client is owned by the runtime */
  }

  #key(key: string): string {
    return `${this.#prefix}:dec:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  }
}
