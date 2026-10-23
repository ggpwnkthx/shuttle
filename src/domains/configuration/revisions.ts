/**
 * The route table in the shared state.
 *
 * The route table of a deployment is either a file or a list of **revisions**
 * in the shared state (§3.4 of the specification). A revision is immutable:
 * a revision that is written is never changed. A separate pointer names the
 * revision that is active, and only the pointer moves.
 *
 * The store keeps the trail of the writes of the control plane (§12.7): an
 * entry is written with the change it records, so a change that left no
 * trace is a change nobody can account for.
 *
 * The domain owns the shape of the records and the contract of the store.
 * The adapters of the store speak to the two servers of the shared state
 * (§12.5), and the two behave the same way: the suite of
 * `test/integration/shared-state-conformance.ts` proves it.
 */

import type { AuditEntry } from '../../observability'

export type { AuditEntry }

/** A revision of the route table. */
export interface RouteTableRevision {
  /** The number of the revision. It grows with every write and never changes. */
  revision: number
  /** The route table, as the file of §3 of the specification. */
  table: unknown
  /** The operator who wrote the revision. */
  author: string
  /** The moment the revision was written, in milliseconds. */
  createdAt: number
}

/**
 * The revision that is active.
 *
 * The pointer is the only thing a write moves: the revisions themselves
 * are immutable.
 */
export interface RouteTablePointer {
  /** The number of the active revision. */
  revision: number
}

/** The heartbeat of a replica that serves the route table. */
export interface ReplicaHeartbeat {
  /** The id of the replica. */
  replicaId: string
  /** The revision the replica serves, or null when it serves none. */
  revision: number | null
  /** The last error of the replica, or null when it has none. */
  lastError: string | null
  /** The moment of the heartbeat, in milliseconds. */
  at: number
}

/** A page of a list. */
export interface Page<T> {
  /** The entries of the page. */
  entries: T[]
  /** The number of entries the whole list holds. */
  total: number
}

/** The result of a write of the route table. */
export type WriteOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict'; active: number | null }

/**
 * The store of the route table in the shared state.
 *
 * The writes are **compare and swap**: the pointer moves only when it still
 * names the revision the writer expected. A writer that lost the race is
 * told so, and nothing is written.
 */
export interface RouteTableStore {
  /** The revision that is active, or null when the store is empty. */
  activePointer(): Promise<RouteTablePointer | null>
  /** A revision by its number, or null when there is none. */
  readRevision(revision: number): Promise<RouteTableRevision | null>
  /** The revisions, the newest first. */
  listRevisions(options: { limit: number; offset: number }): Promise<Page<RouteTableRevision>>
  /**
   * Writes a revision and moves the pointer to it.
   *
   * The expected revision is the one the writer believes is active: `null`
   * when the writer believes the store is empty. The audit entry is written
   * with the revision, in the same transaction.
   */
  writeRevision(input: {
    table: unknown
    author: string
    expectedRevision: number | null
    audit: AuditEntry
  }): Promise<WriteOutcome>
  /** Appends an entry to the audit trail. */
  appendAudit(entry: AuditEntry): Promise<void>
  /** The entries of the audit trail, the newest first. */
  listAudit(options: { limit: number; offset: number }): Promise<Page<AuditEntry>>
  /** Reports whether the store can be reached. */
  ping(): Promise<boolean>
  /** Writes the heartbeat of a replica. The heartbeat expires after the lifetime. */
  writeHeartbeat(heartbeat: ReplicaHeartbeat, lifetimeMs: number): Promise<void>
  /** The heartbeats of the replicas that are alive. */
  listHeartbeats(): Promise<ReplicaHeartbeat[]>
}
