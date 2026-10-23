/**
 * The contract of the control plane.
 *
 * The control plane is the administrative surface of a deployment: it is a
 * separate process, it listens on its own socket and it acts on the shared
 * state directly. The tests drive the application the way an operator
 * does: a token, a scope, and the endpoints of the protocol.
 *
 * The gateway keeps no administrative endpoint: the contract of the gateway
 * is checked here as well.
 */

import { describe, expect, test } from 'bun:test'
import { createControlApp } from '../../src/app/control'
import { ControlService, parseControlTokens } from '../../src/domains/control'
import type {
  AuditEntry,
  Page,
  ReplicaHeartbeat,
  RouteTablePointer,
  RouteTableRevision,
  RouteTableStore,
  WriteOutcome,
} from '../../src/domains/configuration'
import type { SessionStore } from '../../src/domains/authentication'
import type { DecisionCache } from '../../src/domains/workspace-access'
import type { AuthFailureCounter } from '../../src/domains/control'
import { createLogger } from '../../src/observability'

/** The token of the operator that reads. */
const READ_TOKEN = 'read-token-of-the-deployment-0001'
/** The token of the operator that operates. */
const OPERATE_TOKEN = 'operate-token-of-the-deployment-002'
/** The token of the operator that writes the route table. */
const CONFIG_TOKEN = 'config-token-of-the-deployment-0003'

/** A route table of the tests. */
const TABLE = {
  version: 1,
  routes: [
    {
      id: 'admin',
      match: { host: 'admin.shuttle.test', path: '/admin' },
      upstream: 'http://upstream.test',
      auth: { mode: 'none' },
    },
    {
      id: 'app',
      match: { host: 'app.shuttle.test', path: '/app/{rest}' },
      upstream: 'http://upstream.test',
      auth: { mode: 'none' },
    },
  ],
}

/** The store of the route table of the tests: it lives in the memory. */
class MemoryRouteTableStore implements RouteTableStore {
  revisions = new Map<number, RouteTableRevision>()
  trail: AuditEntry[] = []
  heartbeats: ReplicaHeartbeat[] = []
  #active: number | null = null

  async activePointer(): Promise<RouteTablePointer | null> {
    return this.#active === null ? null : { revision: this.#active }
  }

  async readRevision(revision: number): Promise<RouteTableRevision | null> {
    return this.revisions.get(revision) ?? null
  }

  async listRevisions(options: {
    limit: number
    offset: number
  }): Promise<Page<RouteTableRevision>> {
    const entries = [...this.revisions.values()].sort(
      (left, right) => right.revision - left.revision
    )
    return {
      entries: entries.slice(options.offset, options.offset + options.limit),
      total: entries.length,
    }
  }

  async writeRevision(input: {
    table: unknown
    author: string
    expectedRevision: number | null
    audit: AuditEntry
  }): Promise<WriteOutcome> {
    if (input.expectedRevision !== this.#active) {
      return { ok: false, reason: 'conflict', active: this.#active }
    }
    const revision = (this.#active ?? 0) + 1
    this.revisions.set(revision, {
      revision,
      table: input.table,
      author: input.author,
      createdAt: Date.now(),
    })
    this.#active = revision
    // The entry of the trail is written with the revision: a change that
    // left no trace cannot exist.
    this.trail.push(input.audit)
    return { ok: true, revision }
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.trail.push(entry)
  }

  async listAudit(options: { limit: number; offset: number }): Promise<Page<AuditEntry>> {
    const entries = [...this.trail].reverse()
    return {
      entries: entries.slice(options.offset, options.offset + options.limit),
      total: entries.length,
    }
  }

  async ping(): Promise<boolean> {
    return true
  }

  async writeHeartbeat(heartbeat: ReplicaHeartbeat): Promise<void> {
    this.heartbeats = [
      ...this.heartbeats.filter((entry) => entry.replicaId !== heartbeat.replicaId),
      heartbeat,
    ]
  }

  async listHeartbeats(): Promise<ReplicaHeartbeat[]> {
    return this.heartbeats
  }
}

/** The store of the sessions of the tests. */
class MemorySessions implements SessionStore {
  readonly ttlMs = 60_000
  readonly maxAgeMs = 0
  readonly touchIntervalMs = 60_000
  revoked: { subject: string; audit?: AuditEntry }[] = []

  async create(): Promise<never> {
    throw new Error('the sessions of the tests are not created')
  }
  async get(): Promise<null> {
    return null
  }
  async destroy(): Promise<void> {}
  async destroyBySubject(subject: string, audit?: AuditEntry): Promise<number> {
    this.revoked.push({ subject, audit })
    return 1
  }
  async ping(): Promise<boolean> {
    return true
  }
  async close(): Promise<void> {}
}

/** The cache of the decisions of the tests. */
class MemoryDecisions implements DecisionCache {
  purged: { filter: unknown; audit?: AuditEntry }[] = []

  async get(): Promise<null> {
    return null
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async purge(filter: unknown, audit?: AuditEntry): Promise<number> {
    this.purged.push({ filter, audit })
    return 2
  }
  async close(): Promise<void> {}
}

/** The counter of the failed authentications of the tests. */
class MemoryFailures implements AuthFailureCounter {
  counts = new Map<string, number>()
  available = true

  async count(key: string): Promise<number> {
    if (!this.available) throw new Error('the shared state is not reachable')
    return this.counts.get(key) ?? 0
  }

  async record(key: string): Promise<number> {
    if (!this.available) throw new Error('the shared state is not reachable')
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return count
  }
}

/** The parts of the control plane the tests drive. */
interface Harness {
  app: ReturnType<typeof createControlApp>
  routeTable: MemoryRouteTableStore
  sessions: MemorySessions
  decisions: MemoryDecisions
  failures: MemoryFailures
  /** The answer of a request of the control plane. */
  call: (
    path: string,
    options?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> }
  ) => Promise<Response>
}

/** Builds the control plane of the tests. */
function harness(options: { protectedRoutes?: string[] } = {}): Harness {
  const routeTable = new MemoryRouteTableStore()
  const sessions = new MemorySessions()
  const decisions = new MemoryDecisions()
  const failures = new MemoryFailures()
  const tokens = parseControlTokens(
    JSON.stringify({
      [READ_TOKEN]: { operator: 'the-reader', scope: 'read' },
      [OPERATE_TOKEN]: { operator: 'the-operator', scope: 'operate' },
      [CONFIG_TOKEN]: { operator: 'the-configurator', scope: 'config' },
    })
  )
  const service = new ControlService({
    routeTable,
    sessions,
    decisions,
    failures,
    tokens,
    protectedRoutes: options.protectedRoutes ?? [],
    defaults: {
      defaultMaxBodyBytes: 1024,
      defaultUpstreamAttemptMs: 1000,
      defaultReplayMaxBytes: 1024,
      defaultAccessStaleGraceMs: 0,
    },
  })
  const app = createControlApp({
    service,
    logger: createLogger({ level: 'silent' }),
    version: 'test',
    peerAddress: () => '10.0.0.1',
  })
  return {
    app,
    routeTable,
    sessions,
    decisions,
    failures,
    call: async (path, request = {}) => {
      const headers: Record<string, string> = { ...request.headers }
      if (request.token) headers.authorization = `Bearer ${request.token}`
      if (request.body !== undefined) headers['content-type'] = 'application/json'
      return await app.fetch(
        new Request(`http://control.test${path}`, {
          method: request.method ?? 'GET',
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        })
      )
    },
  }
}

describe('the control plane', () => {
  test('the health and the readiness need no token', async () => {
    const { call } = harness()
    const health = await call('/healthz')
    expect(health.status).toBe(200)
    const ready = await call('/readyz')
    expect(ready.status).toBe(200)
  })

  test('a request without a token is refused', async () => {
    const { call } = harness()
    const response = await call('/v1/config')
    expect(response.status).toBe(401)
  })

  test('a request with a wrong token is refused', async () => {
    const { call } = harness()
    const response = await call('/v1/config', { token: 'a-token-that-is-not-known-000' })
    expect(response.status).toBe(401)
  })

  test('the endpoints of the reading are open to the scope of the reading', async () => {
    const { call } = harness()
    for (const path of ['/v1/config', '/v1/config/history', '/v1/replicas', '/v1/audit']) {
      const response = await call(path, { token: READ_TOKEN })
      expect(response.status).toBe(200)
    }
  })

  test('the scope of the reading does not write the route table', async () => {
    const { call } = harness()
    const response = await call('/v1/config', {
      method: 'PUT',
      token: READ_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    expect(response.status).toBe(403)
  })

  test('the scope of the reading does not purge anything', async () => {
    const { call } = harness()
    const sessions = await call('/v1/sessions?subject=user-1', {
      method: 'DELETE',
      token: READ_TOKEN,
    })
    expect(sessions.status).toBe(403)
    const decisions = await call('/v1/decisions?subject=user-1', {
      method: 'DELETE',
      token: READ_TOKEN,
    })
    expect(decisions.status).toBe(403)
  })

  test('the scope of the operating does not write the route table', async () => {
    const { call } = harness()
    const response = await call('/v1/config', {
      method: 'PUT',
      token: OPERATE_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    expect(response.status).toBe(403)
  })

  test('the scope of the writing does not purge anything', async () => {
    const { call } = harness()
    const sessions = await call('/v1/sessions?subject=user-1', {
      method: 'DELETE',
      token: CONFIG_TOKEN,
    })
    expect(sessions.status).toBe(403)
    const decisions = await call('/v1/decisions?subject=user-1', {
      method: 'DELETE',
      token: CONFIG_TOKEN,
    })
    expect(decisions.status).toBe(403)
  })

  test('the scope of the operating purges the sessions and the decisions', async () => {
    const { call, sessions, decisions } = harness()
    const revoked = await call('/v1/sessions?subject=user-1', {
      method: 'DELETE',
      token: OPERATE_TOKEN,
    })
    expect(revoked.status).toBe(200)
    expect(sessions.revoked[0]?.subject).toBe('user-1')

    const purged = await call('/v1/decisions?subject=user-1', {
      method: 'DELETE',
      token: OPERATE_TOKEN,
    })
    expect(purged.status).toBe(200)
    expect(decisions.purged.length).toBe(1)
  })

  test('the scope of the writing writes the route table', async () => {
    const { call, routeTable } = harness()
    const response = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { revision: number }
    expect(body.revision).toBe(1)
    expect((await routeTable.activePointer())?.revision).toBe(1)
  })

  test('a write without the revision it replaces is refused', async () => {
    const { call, routeTable } = harness()
    const response = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
    })
    expect(response.status).toBe(400)
    expect((await routeTable.activePointer())?.revision).toBeUndefined()
  })

  test('a write that lost the race is a conflict', async () => {
    const { call } = harness()
    await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    const stale = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    expect(stale.status).toBe(409)
  })

  test('a write that changes a protected route is a conflict', async () => {
    const { call } = harness({ protectedRoutes: ['admin'] })
    await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    // The route `admin` is removed.
    const removed = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: {
        version: 1,
        routes: [
          {
            id: 'app',
            match: { host: 'app.shuttle.test', path: '/app/{rest}' },
            upstream: 'http://upstream.test',
            auth: { mode: 'none' },
          },
        ],
      },
      headers: { 'if-match': '1' },
    })
    expect(removed.status).toBe(409)
    // The route `admin` is changed.
    const changed = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: {
        version: 1,
        routes: [
          {
            id: 'admin',
            match: { host: 'admin.shuttle.test', path: '/administration' },
            upstream: 'http://upstream.test',
            auth: { mode: 'none' },
          },
          {
            id: 'app',
            match: { host: 'app.shuttle.test', path: '/app/{rest}' },
            upstream: 'http://upstream.test',
            auth: { mode: 'none' },
          },
        ],
      },
      headers: { 'if-match': '1' },
    })
    expect(changed.status).toBe(409)
  })

  test('a write that keeps a protected route is accepted', async () => {
    const { call } = harness({ protectedRoutes: ['admin'] })
    const response = await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    expect(response.status).toBe(200)
  })

  test('the validation writes nothing', async () => {
    const { call, routeTable } = harness()
    const response = await call('/v1/config/validate', {
      method: 'POST',
      token: READ_TOKEN,
      body: TABLE,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; diff: { added: string[] } }
    expect(body.ok).toBe(true)
    expect(body.diff.added).toEqual(['admin', 'app'])
    // Nothing was written: the store is still empty and the trail is
    // empty.
    expect(await routeTable.activePointer()).toBeNull()
    expect(routeTable.trail.length).toBe(0)
  })

  test('the validation of a table that is not valid names the errors', async () => {
    const { call } = harness()
    const response = await call('/v1/config/validate', {
      method: 'POST',
      token: READ_TOKEN,
      body: { version: 1, routes: [{ id: 'broken' }] },
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { ok: boolean; errors: string[] }
    expect(body.ok).toBe(false)
    expect(body.errors.length).toBeGreaterThan(0)
  })

  test('the rollback writes the table of an older revision again', async () => {
    const { call, routeTable } = harness()
    await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: {
        version: 1,
        routes: [
          {
            id: 'other',
            match: { host: 'other.shuttle.test', path: '/other' },
            upstream: 'http://upstream.test',
            auth: { mode: 'none' },
          },
        ],
      },
      headers: { 'if-match': '1' },
    })
    const response = await call('/v1/config/rollback', {
      method: 'POST',
      token: CONFIG_TOKEN,
      body: { revision: 1 },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { revision: number }
    // The rollback is a new revision: the history is not rewritten.
    expect(body.revision).toBe(3)
    const revision = await routeTable.readRevision(3)
    expect(revision?.table).toEqual(TABLE)
  })

  test('every write leaves an entry in the trail', async () => {
    const { call, routeTable } = harness()
    await call('/v1/config', {
      method: 'PUT',
      token: CONFIG_TOKEN,
      body: TABLE,
      headers: { 'if-match': '0' },
    })
    const trail = await call('/v1/audit', { token: READ_TOKEN })
    const body = (await trail.json()) as { total: number; entries: AuditEntry[] }
    expect(body.total).toBe(1)
    expect(body.entries[0]?.action).toBe('config.write')
    expect(body.entries[0]?.operator).toBe('the-configurator')
    expect(body.entries[0]?.scope).toBe('config')
    expect(body.entries[0]?.address).toBe('10.0.0.1')
    expect(routeTable.trail.length).toBe(1)
  })

  test('the trail holds the purge of the sessions', async () => {
    const { call, sessions } = harness()
    await call('/v1/sessions?subject=user-1', { method: 'DELETE', token: OPERATE_TOKEN })
    expect(sessions.revoked[0]?.audit?.action).toBe('sessions.revoke')
    expect(sessions.revoked[0]?.audit?.operator).toBe('the-operator')
  })

  test('five failures of an address refuse the sixth', async () => {
    const { call, failures } = harness()
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await call('/v1/config', { token: 'a-wrong-token-00000000000000' })
      expect(response.status).toBe(401)
    }
    expect(failures.counts.get('10.0.0.1')).toBe(5)
    // The sixth attempt is refused with the limit, and the counter does
    // not grow any more.
    const refused = await call('/v1/config', { token: 'a-wrong-token-00000000000000' })
    expect(refused.status).toBe(429)
    expect(failures.counts.get('10.0.0.1')).toBe(5)
  })

  test('a state that cannot be reached refuses the request', async () => {
    const { call, failures } = harness()
    failures.available = false
    const response = await call('/v1/config', { token: READ_TOKEN })
    expect(response.status).toBe(503)
  })

  test('a map of tokens that cannot be read stops the process', () => {
    expect(() => parseControlTokens('not json')).toThrow()
    expect(() => parseControlTokens('[]')).toThrow()
    expect(() => parseControlTokens('{}')).toThrow()
    // A token that is too short is refused.
    expect(() =>
      parseControlTokens(JSON.stringify({ short: { operator: 'o', scope: 'read' } }))
    ).toThrow()
    // A scope that is not known is refused.
    expect(() =>
      parseControlTokens(
        JSON.stringify({ 'a-token-that-is-long-enough': { operator: 'o', scope: 'admin' } })
      )
    ).toThrow()
    // An operator that is not named is refused.
    expect(() =>
      parseControlTokens(JSON.stringify({ 'a-token-that-is-long-enough': { scope: 'read' } }))
    ).toThrow()
  })

  test('a token that is not the secret of something else is the rule of the deployment', () => {
    // The map is read as it is: the deployment is the one that keeps the
    // credentials apart.
    const tokens = parseControlTokens(
      JSON.stringify({ 'a-token-that-is-long-enough': { operator: 'o', scope: 'read' } })
    )
    expect(tokens.size).toBe(1)
  })
})
