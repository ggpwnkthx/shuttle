/**
 * The route table in a Postgres server.
 *
 * The store is the counterpart of the one of Redis: the same contract, the
 * same behaviour, another server. The revisions are rows of a table, the
 * pointer is a row of another one, and the trail of the writes is a third
 * one.
 *
 * The write of a revision is **one transaction**: it reads the pointer,
 * refuses the write when the pointer moved, writes the revision, moves the
 * pointer and writes the entry of the audit trail. The transaction is a
 * transaction of the server, so the trail and the table cannot exist
 * without each other.
 *
 * The tables are built by the schema of the shared state
 * (`src/platform/postgres/schema.ts`), and the statements are idempotent.
 */

import type {
  AuditEntry,
  Page,
  ReplicaHeartbeat,
  RouteTablePointer,
  RouteTableRevision,
  RouteTableStore,
  WriteOutcome,
} from '../revisions'

/**
 * The part of a Postgres client the store needs.
 *
 * The domain does not know the client of the runtime: it knows the command
 * it sends, and the platform builds a client that speaks it.
 */
export interface PostgresRouteTableCommands {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
  /**
   * Runs the body in a transaction.
   *
   * The write of a revision needs it: the read of the pointer, the write
   * of the revision and the write of the trail are one transaction.
   */
  transaction<T>(
    body: (client: {
      query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
    }) => Promise<T>
  ): Promise<T>
}

export interface PostgresRouteTableStoreOptions {
  /** The client of the server. */
  client: PostgresRouteTableCommands
  /**
   * The namespace of the table in the database.
   *
   * It is the prefix of the keys of the state, the way it is in Redis:
   * several deployments may share one database, and the route table of one
   * of them is not the route table of the others.
   */
  namespace?: string
}

/**
 * The route table of a Postgres server.
 *
 * The store is the one the control plane writes and the one the gateway
 * reads: the gateway never writes a revision, it only reads the pointer
 * and writes its own heartbeat.
 */
export class PostgresRouteTableStore implements RouteTableStore {
  #client: PostgresRouteTableCommands
  #namespace: string

  constructor(options: PostgresRouteTableStoreOptions) {
    this.#client = options.client
    this.#namespace = options.namespace ?? 'shuttle'
  }

  async activePointer(): Promise<RouteTablePointer | null> {
    const result = await this.#client.query<{ revision: string | number }>(
      `SELECT revision FROM shuttle.config_active WHERE namespace = $1`,
      [this.#namespace]
    )
    const revision = result.rows[0]?.revision
    if (revision === undefined) return null
    const number = Number(revision)
    return Number.isFinite(number) ? { revision: number } : null
  }

  async readRevision(revision: number): Promise<RouteTableRevision | null> {
    const result = await this.#client.query<{
      revision: string | number
      body: unknown
      author: string
      created_at: Date | string
    }>(
      `SELECT revision, body, author, created_at
         FROM shuttle.config_revisions
        WHERE namespace = $1 AND revision = $2`,
      [this.#namespace, revision]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      revision: Number(row.revision),
      table: row.body,
      author: row.author,
      createdAt: toMillis(row.created_at),
    }
  }

  async listRevisions(options: {
    limit: number
    offset: number
  }): Promise<Page<RouteTableRevision>> {
    const count = await this.#client.query<{ total: string | number }>(
      `SELECT count(*)::bigint AS total
         FROM shuttle.config_revisions
        WHERE namespace = $1`,
      [this.#namespace]
    )
    const total = Number(count.rows[0]?.total ?? 0)
    const result = await this.#client.query<{
      revision: string | number
      body: unknown
      author: string
      created_at: Date | string
    }>(
      `SELECT revision, body, author, created_at
         FROM shuttle.config_revisions
        WHERE namespace = $1
        ORDER BY revision DESC
        LIMIT $2 OFFSET $3`,
      [this.#namespace, Math.max(0, options.limit), Math.max(0, options.offset)]
    )
    const entries = result.rows.map((row) => ({
      revision: Number(row.revision),
      table: row.body,
      author: row.author,
      createdAt: toMillis(row.created_at),
    }))
    return { entries, total }
  }

  async writeRevision(input: {
    table: unknown
    author: string
    expectedRevision: number | null
    audit: AuditEntry
  }): Promise<WriteOutcome> {
    return await this.#client.transaction(async (tx) => {
      // The writes are serialized: two control planes that write at the
      // same time do not pick the same number of the revision.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('shuttle_config_revision', 0))`)
      const pointer = await tx.query<{ revision: string | number }>(
        `SELECT revision FROM shuttle.config_active WHERE namespace = $1 FOR UPDATE`,
        [this.#namespace]
      )
      const active = pointer.rows[0]?.revision
      const current = active === undefined ? null : Number(active)
      if (current !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', active: current } as const
      }
      const last = await tx.query<{ last: string | number | null }>(
        `SELECT max(revision)::bigint AS last
           FROM shuttle.config_revisions
          WHERE namespace = $1`,
        [this.#namespace]
      )
      const revision = Number(last.rows[0]?.last ?? 0) + 1
      const now = Date.now()
      await tx.query(
        `INSERT INTO shuttle.config_revisions (namespace, revision, body, author, created_at)
         VALUES ($1, $2, $3::jsonb, $4, to_timestamp(($5 / 1000.0)::double precision))`,
        [this.#namespace, revision, JSON.stringify(input.table ?? null), input.author, now]
      )
      await tx.query(
        `INSERT INTO shuttle.config_active (namespace, revision, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (namespace) DO UPDATE
            SET revision = EXCLUDED.revision, updated_at = now()`,
        [this.#namespace, revision]
      )
      await tx.query(
        `INSERT INTO shuttle.audit (action, target, operator, scope, address, request, at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp(($7 / 1000.0)::double precision))`,
        [
          input.audit.action,
          input.audit.target,
          input.audit.operator,
          input.audit.scope,
          input.audit.address,
          JSON.stringify(input.audit.request ?? null),
          input.audit.at,
        ]
      )
      return { ok: true, revision } as const
    })
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO shuttle.audit (action, target, operator, scope, address, request, at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp(($7 / 1000.0)::double precision))`,
      [
        entry.action,
        entry.target,
        entry.operator,
        entry.scope,
        entry.address,
        JSON.stringify(entry.request ?? null),
        entry.at,
      ]
    )
  }

  async listAudit(options: { limit: number; offset: number }): Promise<Page<AuditEntry>> {
    const count = await this.#client.query<{ total: string | number }>(
      `SELECT count(*)::bigint AS total FROM shuttle.audit`
    )
    const total = Number(count.rows[0]?.total ?? 0)
    const result = await this.#client.query<{
      action: string
      target: string
      operator: string
      scope: string
      address: string
      request: unknown
      at: Date | string
    }>(
      `SELECT action, target, operator, scope, address, request, at
         FROM shuttle.audit
        ORDER BY id DESC
        LIMIT $1 OFFSET $2`,
      [Math.max(0, options.limit), Math.max(0, options.offset)]
    )
    const entries = result.rows.map((row) => ({
      action: row.action,
      target: row.target,
      operator: row.operator,
      scope: row.scope,
      address: row.address,
      request: row.request ?? null,
      at: toMillis(row.at),
    }))
    return { entries, total }
  }

  async ping(): Promise<boolean> {
    try {
      await this.#client.query(`SELECT 1`)
      return true
    } catch {
      return false
    }
  }

  async writeHeartbeat(heartbeat: ReplicaHeartbeat, lifetimeMs: number): Promise<void> {
    await this.#client.query(
      `INSERT INTO shuttle.config_heartbeats (namespace, replica_id, revision, last_error, at, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp(($5 / 1000.0)::double precision),
               now() + ($6::bigint * interval '1 millisecond'))
       ON CONFLICT (namespace, replica_id) DO UPDATE
          SET revision = EXCLUDED.revision,
              last_error = EXCLUDED.last_error,
              at = EXCLUDED.at,
              expires_at = EXCLUDED.expires_at`,
      [
        this.#namespace,
        heartbeat.replicaId,
        heartbeat.revision,
        heartbeat.lastError,
        heartbeat.at,
        lifetimeMs,
      ]
    )
  }

  async listHeartbeats(): Promise<ReplicaHeartbeat[]> {
    const result = await this.#client.query<{
      replica_id: string
      revision: string | number | null
      last_error: string | null
      at: Date | string
    }>(
      `SELECT replica_id, revision, last_error, at
         FROM shuttle.config_heartbeats
        WHERE namespace = $1 AND expires_at > now()
        ORDER BY replica_id`,
      [this.#namespace]
    )
    return result.rows.map((row) => ({
      replicaId: row.replica_id,
      revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
      lastError: row.last_error,
      at: toMillis(row.at),
    }))
  }
}

/** Reads a moment of the server as a number of milliseconds. */
function toMillis(value: Date | string): number {
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
