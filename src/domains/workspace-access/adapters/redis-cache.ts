/**
 * The cache of the decisions that lives in a Redis server.
 *
 * A deployment with more than one replica uses it, so every replica answers
 * with the same decision and the access service sees one request instead of
 * one per replica.
 *
 * The cache is a cache: when the server cannot be reached, the decision is
 * asked for again. A cache that is not available never changes the answer of
 * a request.
 */

import { createHash } from 'node:crypto'
import { isAccessReasonCode } from '../decision'
import type { CachedDecision, DecisionCache } from '../client'

/**
 * The part of a Redis client the cache needs.
 *
 * The domain does not know the client of the runtime: it knows the commands
 * it sends, and the platform builds a client that speaks them.
 */
export interface RedisCacheCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
}

export interface RedisDecisionCacheOptions {
  /** The client of the server. */
  client: RedisCacheCommands
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /** Called when the server cannot be reached. */
  onError?: (error: unknown) => void
}

export class RedisDecisionCache implements DecisionCache {
  #client: RedisCacheCommands
  #prefix: string
  #onError?: (error: unknown) => void

  constructor(options: RedisDecisionCacheOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#onError = options.onError
  }

  async get(key: string): Promise<CachedDecision | null> {
    try {
      const raw = await this.#client.get(this.#key(key))
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<CachedDecision>
      if (typeof parsed.allow !== 'boolean') return null
      return {
        allow: parsed.allow,
        // A record that was written before the kind was carried is read as
        // the decision it is: only an explicit decision is ever cached.
        kind: parsed.kind ?? (parsed.allow ? 'allowed' : 'denied'),
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        // The code of the reason is carried, so that a decision that comes
        // from the cache is counted as exactly as the one that was asked
        // for. A record that carries no code is counted with the legacy
        // rule.
        reasonCode: isAccessReasonCode(parsed.reasonCode) ? parsed.reasonCode : undefined,
        decidedAt: typeof parsed.decidedAt === 'number' ? parsed.decidedAt : Date.now(),
      }
    } catch (error) {
      // The cache is not available: the decision is asked for again.
      this.#onError?.(error)
      return null
    }
  }

  async set(key: string, decision: CachedDecision, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    try {
      await this.#client.set(
        this.#key(key),
        JSON.stringify(decision),
        'PX',
        Math.max(1, Math.ceil(ttlMs))
      )
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#client.del(this.#key(key))
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async close(): Promise<void> {
    // The client is owned by the runtime.
  }

  /** The key of a decision in the server. */
  #key(key: string): string {
    return `${this.#prefix}:dec:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  }
}
