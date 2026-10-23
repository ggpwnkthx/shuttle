/**
 * The service of the control plane.
 *
 * The service owns the rules of the administrative writes: what a write
 * changes, what it may not change, and what it leaves behind. The
 * application maps the requests of the protocol to the calls of the
 * service, and the service answers with the outcome the application turns
 * into a status.
 *
 * Every write of the service leaves an entry in the audit trail, and the
 * entry is written with the change: the store that performs the change
 * writes it in the same transaction.
 */

import type { AuditEntry } from '../../observability'
import {
  compileTable,
  describeTable,
  diffTables,
  routeDefinitions,
  type EnvironmentDefaults,
  type RouteTableStore,
} from '../configuration'
import type { SessionStore } from '../authentication'
import type { DecisionCache } from '../workspace-access'
import { protectedRoutesViolations, type ControlIdentity, type ControlTokens } from './policy'

/** The counter of the failures of the authentication of the control plane. */
export interface AuthFailureCounter {
  /** The number of failures of an address in the window. */
  count(key: string, windowMs: number): Promise<number>
  /** Records a failure and returns the number of failures in the window. */
  record(key: string, windowMs: number): Promise<number>
}

/** The outcome of a write of the route table. */
export type ConfigWriteOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict'; active: number | null }
  | { ok: false; reason: 'invalid'; errors: string[]; conflicts: string[] }
  | { ok: false; reason: 'protected'; routes: string[] }

/** The answer of the validation of a table. */
export interface ConfigValidation {
  /** True when the table may be written. */
  ok: boolean
  /** The errors of the schema of the table. */
  errors: string[]
  /** The ambiguities of the table. */
  conflicts: string[]
  /** The warnings of the table. */
  warnings: string[]
  /** The difference with the active table. */
  diff: { added: string[]; removed: string[]; changed: string[] }
}

/** The options of the service. */
export interface ControlServiceOptions {
  /** The store of the route table. */
  routeTable: RouteTableStore
  /** The store of the sessions of the callers. */
  sessions: SessionStore
  /** The cache of the decisions of the access service. */
  decisions: DecisionCache
  /** The counter of the failures of the authentication. */
  failures: AuthFailureCounter
  /** The tokens the control plane accepts. */
  tokens: ControlTokens
  /** The routes a write may not remove and may not change. */
  protectedRoutes?: readonly string[]
  /** The defaults of the deployment, the ones of the file of the gateway. */
  defaults: EnvironmentDefaults
  /** The ranges whose forwarding headers are trusted. */
  trustedProxies?: string[]
  /** True when the environment names the ranges of the trusted proxies. */
  trustedProxiesConfigured?: boolean
  /** The window of the failures of the authentication, in milliseconds. */
  failureWindowMs?: number
}

/**
 * The service of the control plane.
 *
 * The service never talks to the network and never reads the environment:
 * it receives the stores it acts on and it answers with the outcome of the
 * write.
 */
export class ControlService {
  #routeTable: RouteTableStore
  #sessions: SessionStore
  #decisions: DecisionCache
  #failures: AuthFailureCounter
  #tokens: ControlTokens
  #protectedRoutes: readonly string[]
  #defaults: EnvironmentDefaults
  #trustedProxies: string[]
  #trustedProxiesConfigured: boolean
  #failureWindowMs: number

  constructor(options: ControlServiceOptions) {
    this.#routeTable = options.routeTable
    this.#sessions = options.sessions
    this.#decisions = options.decisions
    this.#failures = options.failures
    this.#tokens = options.tokens
    this.#protectedRoutes = options.protectedRoutes ?? []
    this.#defaults = options.defaults
    this.#trustedProxies = options.trustedProxies ?? []
    this.#trustedProxiesConfigured = options.trustedProxiesConfigured ?? false
    this.#failureWindowMs = options.failureWindowMs ?? 60_000
  }

  /** The tokens the control plane accepts. */
  get tokens(): ControlTokens {
    return this.#tokens
  }

  /** Reports whether the shared state the control plane acts on answers. */
  async ping(): Promise<boolean> {
    return await this.#routeTable.ping()
  }

  /**
   * The number of failures of the authentication of an address.
   *
   * The counter lives in the shared state, so the limit holds across the
   * replicas of the control plane.
   */
  async failureCount(address: string): Promise<number> {
    return await this.#failures.count(address, this.#failureWindowMs)
  }

  /** Records a failure of the authentication and returns the new count. */
  async recordFailure(address: string): Promise<number> {
    return await this.#failures.record(address, this.#failureWindowMs)
  }

  /** The active revision of the route table and the table it holds. */
  async activeConfig(): Promise<{
    revision: number | null
    table: unknown
    author: string | null
    createdAt: number | null
  }> {
    const pointer = await this.#routeTable.activePointer()
    if (!pointer) return { revision: null, table: null, author: null, createdAt: null }
    const revision = await this.#routeTable.readRevision(pointer.revision)
    return {
      revision: pointer.revision,
      table: revision?.table ?? null,
      author: revision?.author ?? null,
      createdAt: revision?.createdAt ?? null,
    }
  }

  /**
   * Validates a table without writing anything.
   *
   * The answer holds the errors, the ambiguities, the warnings and the
   * difference with the active table: an operator sees what a write does
   * before it writes it.
   */
  async validate(table: unknown): Promise<ConfigValidation> {
    const result = compileTable(
      table,
      this.#defaults,
      this.#trustedProxies,
      this.#trustedProxiesConfigured
    )
    const active = await this.activeConfig()
    const diff = diffTables(active.table, table)
    if (!result.ok) {
      return {
        ok: false,
        errors: result.errors,
        conflicts: result.conflicts,
        warnings: [],
        diff,
      }
    }
    return {
      ok: true,
      errors: [],
      conflicts: [],
      warnings: describeTable(result.table).warnings.map((warning) => warning.message),
      diff,
    }
  }

  /**
   * Writes the route table as a new revision.
   *
   * The write is a compare and swap: the pointer moves only when it still
   * names the revision the caller expected. A table that is not valid and a
   * table that changes a protected route are refused before anything is
   * written.
   */
  async writeConfig(input: {
    table: unknown
    expectedRevision: number | null
    identity: ControlIdentity
    address: string
    request: unknown
  }): Promise<ConfigWriteOutcome> {
    const compiled = compileTable(
      input.table,
      this.#defaults,
      this.#trustedProxies,
      this.#trustedProxiesConfigured
    )
    if (!compiled.ok) {
      return {
        ok: false,
        reason: 'invalid',
        errors: compiled.errors,
        conflicts: compiled.conflicts,
      }
    }
    const active = await this.activeConfig()
    const violations = protectedRoutesViolations(
      this.#protectedRoutes,
      routeDefinitions(active.table),
      routeDefinitions(input.table)
    )
    if (violations.length > 0) {
      return { ok: false, reason: 'protected', routes: violations }
    }
    const outcome = await this.#routeTable.writeRevision({
      table: input.table,
      author: input.identity.operator,
      expectedRevision: input.expectedRevision,
      audit: this.#audit(
        'config.write',
        targetOf(input.table),
        input.identity,
        input.address,
        input.request
      ),
    })
    if (!outcome.ok) return { ok: false, reason: 'conflict', active: outcome.active }
    return { ok: true, revision: outcome.revision }
  }

  /** The revisions of the route table, the newest first. */
  async history(options: { limit: number; offset: number }) {
    return await this.#routeTable.listRevisions(options)
  }

  /**
   * Writes the table of an older revision again, as a new revision.
   *
   * The revisions are immutable: a rollback that rewrote an old revision
   * would erase the history of what happened in between.
   */
  async rollback(input: {
    revision: number
    expectedRevision: number | null
    identity: ControlIdentity
    address: string
  }): Promise<ConfigWriteOutcome> {
    const revision = await this.#routeTable.readRevision(input.revision)
    if (!revision) {
      return {
        ok: false,
        reason: 'invalid',
        errors: ['the revision does not exist'],
        conflicts: [],
      }
    }
    // A rollback that does not name the revision it replaces writes over
    // the one that is active at that moment.
    const expected =
      input.expectedRevision ?? (await this.#routeTable.activePointer())?.revision ?? null
    return await this.writeConfig({
      table: revision.table,
      expectedRevision: expected,
      identity: input.identity,
      address: input.address,
      request: { action: 'config.rollback', revision: input.revision },
    })
  }

  /** The heartbeats of the replicas that serve the route table. */
  async replicas() {
    return await this.#routeTable.listHeartbeats()
  }

  /** Revokes the sessions of a subject. */
  async revokeSessions(input: {
    subject: string
    identity: ControlIdentity
    address: string
  }): Promise<number> {
    return await this.#sessions.destroyBySubject(
      input.subject,
      this.#audit('sessions.revoke', input.subject, input.identity, input.address, {
        subject: input.subject,
      })
    )
  }

  /** Purges the cached decisions of a subject and of a workspace. */
  async purgeDecisions(input: {
    subject?: string
    workspaceId?: string
    identity: ControlIdentity
    address: string
  }): Promise<number> {
    const target = [input.subject, input.workspaceId].filter(Boolean).join('/')
    return await this.#decisions.purge(
      { subject: input.subject, workspaceId: input.workspaceId },
      this.#audit('decisions.purge', target, input.identity, input.address, {
        subject: input.subject,
        workspaceId: input.workspaceId,
      })
    )
  }

  /** The entries of the audit trail, the newest first. */
  async audit(options: { limit: number; offset: number }) {
    return await this.#routeTable.listAudit(options)
  }

  /** Builds the entry of the audit trail of a write. */
  #audit(
    action: string,
    target: string,
    identity: ControlIdentity,
    address: string,
    request: unknown
  ): AuditEntry {
    return {
      action,
      target,
      operator: identity.operator,
      scope: identity.scope,
      address,
      request,
      at: Date.now(),
    }
  }
}

/** The target of a write: the ids of the routes of the table. */
function targetOf(table: unknown): string {
  return routeDefinitions(table)
    .map((route) => route.id)
    .sort()
    .join(',')
}
