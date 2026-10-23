/**
 * The cache of the decisions that lives in the memory of the process.
 *
 * The cache is bounded: a decision of a workspace that nobody asks for
 * anymore does not stay in the memory of the process for ever.
 */

import { LRUCache } from 'lru-cache'
import type { AuditEntry } from '../../../observability'
import type { CachedDecision, DecisionCache, DecisionMeta, DecisionPurgeFilter } from '../client'

export interface MemoryDecisionCacheOptions {
  /** The number of decisions that are kept at the same time. */
  maxEntries?: number
}

/** The default number of decisions of the cache. */
export const DEFAULT_MAX_DECISIONS = 1_000

/** A decision of the cache, with what it is about. */
interface MemoryDecision {
  decision: CachedDecision
  meta: DecisionMeta
}

export class MemoryDecisionCache implements DecisionCache {
  #cache: LRUCache<string, MemoryDecision>

  constructor(options: MemoryDecisionCacheOptions = {}) {
    this.#cache = new LRUCache<string, MemoryDecision>({
      max: options.maxEntries ?? DEFAULT_MAX_DECISIONS,
    })
  }

  /** The number of decisions that are cached. */
  get size(): number {
    return this.#cache.size
  }

  async get(key: string): Promise<CachedDecision | null> {
    return this.#cache.get(key)?.decision ?? null
  }

  async set(
    key: string,
    decision: CachedDecision,
    ttlMs: number,
    meta?: DecisionMeta
  ): Promise<void> {
    if (ttlMs <= 0) return
    this.#cache.set(key, { decision, meta: meta ?? {} }, { ttl: ttlMs })
  }

  async delete(key: string): Promise<void> {
    this.#cache.delete(key)
  }

  async purge(filter: DecisionPurgeFilter, _audit?: AuditEntry): Promise<number> {
    let removed = 0
    for (const [key, entry] of [...this.#cache.entries()]) {
      if (!matches(entry.meta, filter)) continue
      this.#cache.delete(key)
      removed += 1
    }
    return removed
  }

  async close(): Promise<void> {
    this.#cache.clear()
  }
}

/** Reports whether a decision is about the caller and the workspace of a filter. */
function matches(meta: DecisionMeta, filter: DecisionPurgeFilter): boolean {
  if (filter.subject !== undefined && meta.subject !== filter.subject) return false
  if (filter.workspaceId !== undefined && meta.workspaceId !== filter.workspaceId) return false
  return true
}
