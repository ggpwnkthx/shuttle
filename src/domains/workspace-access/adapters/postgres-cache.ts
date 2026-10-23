/**
 * The cache of the decisions that lives in a Postgres server.
 *
 * A deployment with more than one replica uses it, so every replica answers
 * with the same decision and the access service sees one request instead
 * of one per replica.
 *
 * The cache is a cache: when the server cannot be reached, the decision is
 * asked for again. A cache that is not available never changes the answer
 * of a request.
 */

import { createHash } from 'node:crypto'
import type { AuditEntry } from '../../../observability'
import { isAccessReasonCode } from '../decision'
import type { CachedDecision, DecisionCache, DecisionMeta, DecisionPurgeFilter } from '../client'

/**
 * The part of a Postgres client the cache needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface PostgresCacheCommands {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
  /**
   * Runs the body in a transaction.
   *
   * The purge of the control plane needs it: the removal of the decisions
   * and the entry of the audit trail are one transaction.
   */
  transaction<T>(
    body: (client: {
      query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
    }) => Promise<T>
  ): Promise<T>
}

export interface PostgresDecisionCacheOptions {
  /** The client of the server. */
  client: PostgresCacheCommands
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  /**
   * How often the expired decisions are removed, in milliseconds.
   *
   * A decision that is over is never served, whether its row is there or
   * not.
   */
  sweepIntervalMs?: number
  /** Called when the server cannot be reached. */
  onError?: (error: unknown) => void
}

/** The default interval between two sweeps of the expired decisions. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export class PostgresDecisionCache implements DecisionCache {
  #client: PostgresCacheCommands
  #prefix: string
  #sweepIntervalMs: number
  #lastSweep = 0
  #onError?: (error: unknown) => void

  constructor(options: PostgresDecisionCacheOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#sweepIntervalMs = Math.max(1_000, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    this.#onError = options.onError
  }

  async get(key: string): Promise<CachedDecision | null> {
    try {
      const result = await this.#client.query<{ decision: unknown }>(
        `SELECT decision FROM shuttle.access_decisions WHERE key = $1 AND expires_at > now()`,
        [this.#key(key)]
      )
      const decision = result.rows[0]?.decision
      if (!decision || typeof decision !== 'object') return null
      const parsed = decision as Partial<CachedDecision>
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
      await this.#client.query(
        `INSERT INTO shuttle.access_decisions (key, decision, subject_hash, workspace_hash, expires_at)
         VALUES ($1, $2::jsonb, $3, $4, now() + ($5::bigint * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE
            SET decision = EXCLUDED.decision,
                subject_hash = EXCLUDED.subject_hash,
                workspace_hash = EXCLUDED.workspace_hash,
                expires_at = EXCLUDED.expires_at`,
        [
          this.#key(key),
          JSON.stringify(decision),
          hashOf(meta?.subject),
          hashOf(meta?.workspaceId),
          Math.ceil(ttlMs),
        ]
      )
      await this.#sweep()
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#client.query(`DELETE FROM shuttle.access_decisions WHERE key = $1`, [
        this.#key(key),
      ])
    } catch (error) {
      this.#onError?.(error)
    }
  }

  async purge(filter: DecisionPurgeFilter, audit?: AuditEntry): Promise<number> {
    try {
      // The purge and the entry of the audit trail are one transaction: a
      // purge that left no trace cannot exist.
      return await this.#client.transaction(async (tx) => {
        const result = await tx.query<{ key: string }>(
          `DELETE FROM shuttle.access_decisions
            WHERE ($1::text IS NULL OR subject_hash = $1)
              AND ($2::text IS NULL OR workspace_hash = $2)
              AND starts_with(key, $3)
            RETURNING key`,
          [hashOf(filter.subject), hashOf(filter.workspaceId), `${this.#prefix}:dec:`]
        )
        if (audit) {
          await tx.query(
            `INSERT INTO shuttle.audit (action, target, operator, scope, address, request, at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp(($7 / 1000.0)::double precision))`,
            [
              audit.action,
              audit.target,
              audit.operator,
              audit.scope,
              audit.address,
              JSON.stringify(audit.request ?? null),
              audit.at,
            ]
          )
        }
        return result.rows.length
      })
    } catch (error) {
      this.#onError?.(error)
      return 0
    }
  }

  async close(): Promise<void> {
    // The client is owned by the runtime.
  }

  /** Removes the decisions that are over. */
  async #sweep(): Promise<void> {
    const now = Date.now()
    if (now - this.#lastSweep < this.#sweepIntervalMs) return
    this.#lastSweep = now
    try {
      await this.#client.query(`DELETE FROM shuttle.access_decisions WHERE expires_at < now()`)
    } catch {
      // The sweep is not the path of a request: a failure of it does not
      // fail the request.
    }
  }

  /**
   * The key of a decision in the server.
   *
   * The prefix is part of the key, the way it is part of the key of Redis:
   * several environments can share one server.
   */
  #key(key: string): string {
    return `${this.#prefix}:dec:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
  }
}

/**
 * The hash of a value of the filter.
 *
 * The subject and the workspace are hashed: they come from the identity
 * provider and from the deployment, and the rows of the table are read by
 * the operators of the deployment. The hash is the one of the key, so the
 * values that are compared are the same ones.
 */
function hashOf(value: string | undefined): string | null {
  if (value === undefined) return null
  return createHash('sha256').update(value).digest('hex')
}
