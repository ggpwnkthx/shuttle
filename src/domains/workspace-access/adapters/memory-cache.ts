/**
 * The cache of the decisions that lives in the memory of the process.
 *
 * The cache is bounded: a decision of a workspace that nobody asks for
 * anymore does not stay in the memory of the process for ever.
 */

import { LRUCache } from 'lru-cache'
import type { CachedDecision, DecisionCache } from '../client'

export interface MemoryDecisionCacheOptions {
  /** The number of decisions that are kept at the same time. */
  maxEntries?: number
}

/** The default number of decisions of the cache. */
export const DEFAULT_MAX_DECISIONS = 1_000

export class MemoryDecisionCache implements DecisionCache {
  #cache: LRUCache<string, CachedDecision>

  constructor(options: MemoryDecisionCacheOptions = {}) {
    this.#cache = new LRUCache<string, CachedDecision>({
      max: options.maxEntries ?? DEFAULT_MAX_DECISIONS,
    })
  }

  /** The number of decisions that are cached. */
  get size(): number {
    return this.#cache.size
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
