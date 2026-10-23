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
import type { AuditEntry } from '../../../observability'
import { isAccessReasonCode } from '../decision'
import type { CachedDecision, DecisionCache, DecisionMeta, DecisionPurgeFilter } from '../client'

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
  /** The keys that match a pattern. */
  keys(pattern: string): Promise<string[]>
  /** Appends a value at the end of a list, when the state has one. */
  rpush?(key: string, ...values: string[]): Promise<number>
}

export interface RedisDecisionCacheOptions {
  /** The client of the server. */
  client: RedisCacheCommands
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /**
   * The key of the audit trail of the state.
   *
   * It is empty when the cache does not write the trail: the gateway never
   * purges a decision by itself, and only the control plane does.
   */
  auditKey?: string
  /** Called when the server cannot be reached. */
  onError?: (error: unknown) => void
}

export class RedisDecisionCache implements DecisionCache {
  #client: RedisCacheCommands
  #prefix: string
  #auditKey: string
  #onError?: (error: unknown) => void

  constructor(options: RedisDecisionCacheOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#auditKey = options.auditKey ?? ''
    this.#onError = options.onError
  }

  async get(key: string): Promise<CachedDecision | null> {
    try {
      const raw = await this.#client.get(this.#key(key))
      if (!raw) return null
      const stored = JSON.parse(raw) as Partial<CachedDecision> & { decision?: unknown }
      // A decision that was written before the metadata existed is the
      // record itself; the one that carries it holds the decision inside.
      const parsed =
        stored !== null && typeof stored === 'object' && stored.decision !== undefined
          ? (stored.decision as Partial<CachedDecision>)
          : stored
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

  async set(
    key: string,
    decision: CachedDecision,
    ttlMs: number,
    meta?: DecisionMeta
  ): Promise<void> {
    if (ttlMs <= 0) return
    try {
      await this.#client.set(
        this.#key(key),
        JSON.stringify({
          decision,
          subjectHash: hashOf(meta?.subject),
          workspaceHash: hashOf(meta?.workspaceId),
        }),
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

  async purge(filter: DecisionPurgeFilter, audit?: AuditEntry): Promise<number> {
    try {
      const subject = hashOf(filter.subject)
      const workspace = hashOf(filter.workspaceId)
      const keys = await this.#client.keys(`${this.#prefix}:dec:*`)
      let removed = 0
      for (const key of keys) {
        const raw = await this.#client.get(key)
        if (!raw) continue
        if (!matches(raw, subject, workspace)) continue
        removed += await this.#client.del(key)
      }
      if (audit) await this.#appendAudit(audit)
      return removed
    } catch (error) {
      this.#onError?.(error)
      return 0
    }
  }

  async close(): Promise<void> {
    // The client is owned by the runtime.
  }

  /** Writes the entry of the audit trail, when the store has one. */
  async #appendAudit(audit: AuditEntry): Promise<void> {
    if (!this.#auditKey) return
    await this.#client.rpush?.(this.#auditKey, JSON.stringify(audit))
  }

  /** The key of a decision in the server. */
  #key(key: string): string {
    return `${this.#prefix}:dec:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  }
}

/**
 * The hash of a value of the filter.
 *
 * The subject and the workspace are hashed: they come from the identity
 * provider and from the deployment, and the keys of the server are read by
 * the operators of the deployment.
 */
function hashOf(value: string | undefined): string | null {
  if (value === undefined) return null
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Reports whether a stored decision is about the caller and the workspace
 * of a filter.
 *
 * A decision that was written before the metadata existed carries none, and
 * it is not about anybody: it is not purged.
 */
function matches(raw: string, subject: string | null, workspace: string | null): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object') return false
  const record = parsed as { subjectHash?: unknown; workspaceHash?: unknown }
  if (subject !== null && record.subjectHash !== subject) return false
  if (workspace !== null && record.workspaceHash !== workspace) return false
  return true
}
