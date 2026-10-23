/**
 * The audit trail of the control plane.
 *
 * Every write of the control plane leaves an entry: what it did, what it
 * acted on, who did it, with which scope, from where, with which request
 * and when.
 *
 * The shape of the entry lives in the observation layer, because every
 * domain that performs an audited write needs it and the observation layer
 * is the only one that depends on nothing: the authentication domain, the
 * workspace access domain and the configuration domain all write the trail
 * of the same control plane, and none of them may depend on another.
 *
 * The trail itself lives in the shared state: the store that performs the
 * change writes the entry in the same transaction as the change, so a
 * change that left no trace cannot exist.
 */

/**
 * An entry of the audit trail.
 *
 * The fields are the ones an operator asks for when a change is
 * questioned: what happened, to what, by whom, and when.
 */
export interface AuditEntry {
  /** What the write did: `config.write`, `config.rollback`, `sessions.revoke`, `decisions.purge`. */
  action: string
  /** What the write acted on: the revision, the subject, the workspace. */
  target: string
  /** The operator who wrote, as the token of the caller named it. */
  operator: string
  /** The scope the operator held. */
  scope: string
  /** The address of the caller. */
  address: string
  /** The request that caused the write. */
  request: unknown
  /** The moment of the write, in milliseconds. */
  at: number
}

/** The entry of the trail, as it is stored. */
interface StoredAuditEntry {
  action?: unknown
  target?: unknown
  operator?: unknown
  scope?: unknown
  address?: unknown
  request?: unknown
  at?: unknown
}

/** Serializes an entry for the trail. */
export function serializeAudit(entry: AuditEntry): string {
  return JSON.stringify({
    action: entry.action,
    target: entry.target,
    operator: entry.operator,
    scope: entry.scope,
    address: entry.address,
    request: entry.request ?? null,
    at: entry.at,
  })
}

/**
 * Reads an entry of the trail.
 *
 * An entry that cannot be read is null: the trail is written by several
 * stores and a record that is broken is skipped rather than failing the
 * answer of an operator that asks for the trail.
 */
export function parseAudit(raw: string): AuditEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const stored = parsed as StoredAuditEntry
  if (typeof stored.action !== 'string') return null
  return {
    action: stored.action,
    target: typeof stored.target === 'string' ? stored.target : '',
    operator: typeof stored.operator === 'string' ? stored.operator : '',
    scope: typeof stored.scope === 'string' ? stored.scope : '',
    address: typeof stored.address === 'string' ? stored.address : '',
    request: stored.request ?? null,
    at: typeof stored.at === 'number' ? stored.at : 0,
  }
}
