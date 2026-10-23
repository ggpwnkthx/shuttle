/**
 * The route table in the shared state.
 *
 * The gateway may read its route table from the shared state instead of a
 * file (§3.4 of the specification). The tests drive the watcher of the
 * pointer: a new revision is applied through the same path as the file, a
 * broken table never takes a running deployment out of rotation, and a
 * store that cannot be reached keeps the last valid table.
 *
 * The tests run against the in-process engine of Postgres, so they run
 * everywhere. The contract of the store itself is proved by the suite of
 * the shared state (`shared-state-conformance.ts`), against both servers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ConfigurationStore } from '../../src/domains/configuration'
import { PostgresRouteTableStore } from '../../src/domains/configuration/adapters'
import { MetricsStore } from '../../src/observability'
import { createLogger } from '../../src/observability'
import { loadInitialConfiguration, watchRouteTable } from '../../src/runtime/lifecycle'
import { startPostgres, type PostgresTestServer } from './postgres-server'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let server: PostgresTestServer | undefined

/** A namespace that is unique to the store, so the tests do not collide. */
function namespace(): string {
  return `test-route-table-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString(36)}`
}

/** The table of the tests. */
const TABLE = {
  version: 1,
  routes: [
    {
      id: 'admin',
      match: { host: 'admin.shuttle.test', path: '/admin' },
      upstream: 'http://upstream.test',
      auth: { mode: 'none' },
    },
  ],
}

/** The store of the configuration of the tests. */
function configurationStore(): ConfigurationStore {
  return new ConfigurationStore({
    source: 'the shared state',
    defaultMaxBodyBytes: 1024,
    defaultUpstreamAttemptMs: 1000,
    defaultReplayMaxBytes: 1024,
    defaultAccessStaleGraceMs: 0,
  })
}

/** Waits for a condition, or gives up. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(20)
  }
  return condition()
}

beforeAll(async () => {
  server = await startPostgres()
})

afterAll(async () => {
  await server?.close()
})

describe('the route table in the shared state', () => {
  test('an empty store falls back to the file of the deployment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-route-table-'))
    const path = join(directory, 'routes.json')
    await writeFile(path, JSON.stringify(TABLE), 'utf8')
    const config = configurationStore()
    const observer = new MetricsStore()
    const routeTable = new PostgresRouteTableStore({
      client: server!,
      namespace: namespace(),
    })

    const loaded = await loadInitialConfiguration({
      store: config,
      path,
      routeTable,
      logger: createLogger({ level: 'silent' }),
      observer,
    })
    expect(loaded).toBe(true)
    // The file of the deployment is the table: the store is empty.
    expect(config.snapshot?.routes.map((route) => route.id)).toEqual(['admin'])
  })

  test('the table of the store wins over the file of the deployment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-route-table-'))
    const path = join(directory, 'routes.json')
    await writeFile(path, JSON.stringify(TABLE), 'utf8')
    const config = configurationStore()
    const observer = new MetricsStore()
    const ns = namespace()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })
    const written = await routeTable.writeRevision({
      table: {
        version: 1,
        routes: [
          {
            id: 'from-the-store',
            match: { host: 'store.shuttle.test', path: '/store' },
            upstream: 'http://upstream.test',
            auth: { mode: 'none' },
          },
        ],
      },
      author: 'the-operator',
      expectedRevision: null,
      audit: {
        action: 'config.write',
        target: 'route-table',
        operator: 'the-operator',
        scope: 'config',
        address: '127.0.0.1',
        request: {},
        at: Date.now(),
      },
    })
    expect(written.ok).toBe(true)

    const loaded = await loadInitialConfiguration({
      store: config,
      path,
      routeTable,
      logger: createLogger({ level: 'silent' }),
      observer,
    })
    expect(loaded).toBe(true)
    expect(config.snapshot?.routes.map((route) => route.id)).toEqual(['from-the-store'])
  })

  test('a revision of the store becomes the running configuration', async () => {
    const ns = namespace()
    const store = new PostgresRouteTableStore({ client: server!, namespace: ns })
    const config = configurationStore()
    const observer = new MetricsStore()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })

    const written = await routeTable.writeRevision({
      table: TABLE,
      author: 'the-operator',
      expectedRevision: null,
      audit: {
        action: 'config.write',
        target: 'route-table',
        operator: 'the-operator',
        scope: 'config',
        address: '127.0.0.1',
        request: {},
        at: Date.now(),
      },
    })
    expect(written.ok).toBe(true)

    const watcher = watchRouteTable({
      store: config,
      routeTable: store,
      logger: createLogger({ level: 'silent' }),
      observer,
      replicaId: 'replica-1',
      pollIntervalMs: 50,
      heartbeatIntervalMs: 50,
      heartbeatLifetimeMs: 5_000,
    })
    try {
      const applied = await waitFor(() => config.snapshot !== null)
      expect(applied).toBe(true)
      expect(config.snapshot?.routes.map((route) => route.id)).toEqual(['admin'])
      expect(watcher.revision()).toBe(written.ok ? written.revision : null)
    } finally {
      watcher.stop()
    }
  })

  test('two replicas converge on the same revision', async () => {
    const ns = namespace()
    const first = configurationStore()
    const second = configurationStore()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })

    const written = await routeTable.writeRevision({
      table: TABLE,
      author: 'the-operator',
      expectedRevision: null,
      audit: {
        action: 'config.write',
        target: 'route-table',
        operator: 'the-operator',
        scope: 'config',
        address: '127.0.0.1',
        request: {},
        at: Date.now(),
      },
    })
    expect(written.ok).toBe(true)

    const watchers = [
      watchRouteTable({
        store: first,
        routeTable,
        logger: createLogger({ level: 'silent' }),
        observer: new MetricsStore(),
        replicaId: 'replica-a',
        pollIntervalMs: 50,
      }),
      watchRouteTable({
        store: second,
        routeTable,
        logger: createLogger({ level: 'silent' }),
        observer: new MetricsStore(),
        replicaId: 'replica-b',
        pollIntervalMs: 50,
      }),
    ]
    try {
      const applied = await waitFor(() => first.snapshot !== null && second.snapshot !== null)
      expect(applied).toBe(true)
      // The two replicas serve the same revision and the same routes.
      expect(first.snapshot?.routes.map((route) => route.id)).toEqual(['admin'])
      expect(second.snapshot?.routes.map((route) => route.id)).toEqual(['admin'])
      expect(watchers[0]!.revision()).toBe(watchers[1]!.revision())
    } finally {
      for (const watcher of watchers) watcher.stop()
    }
  })

  test('a broken table never takes the running configuration out of rotation', async () => {
    const ns = namespace()
    const store = new PostgresRouteTableStore({ client: server!, namespace: ns })
    const config = configurationStore()
    const observer = new MetricsStore()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })

    const written = await routeTable.writeRevision({
      table: TABLE,
      author: 'the-operator',
      expectedRevision: null,
      audit: {
        action: 'config.write',
        target: 'route-table',
        operator: 'the-operator',
        scope: 'config',
        address: '127.0.0.1',
        request: {},
        at: Date.now(),
      },
    })
    expect(written.ok).toBe(true)

    const watcher = watchRouteTable({
      store: config,
      routeTable: store,
      logger: createLogger({ level: 'silent' }),
      observer,
      replicaId: 'replica-1',
      pollIntervalMs: 50,
    })
    try {
      expect(await waitFor(() => config.snapshot !== null)).toBe(true)
      const routes = config.snapshot?.routes.map((route) => route.id)

      // A table that is not valid is refused: the last good table stays
      // active and the failure is reported.
      await routeTable.writeRevision({
        table: { version: 1, routes: [{ id: 'broken' }] },
        author: 'the-operator',
        expectedRevision: written.ok ? written.revision : null,
        audit: {
          action: 'config.write',
          target: 'route-table',
          operator: 'the-operator',
          scope: 'config',
          address: '127.0.0.1',
          request: {},
          at: Date.now(),
        },
      })
      const failed = await waitFor(() => config.lastError !== null)
      expect(failed).toBe(true)
      expect(config.snapshot?.routes.map((route) => route.id)).toEqual(routes)

      // The metric of the failed reloads counted the failure.
      const metrics = await observer.render()
      expect(metrics).toContain('shuttle_config_reloads_total{result="failed"}')
    } finally {
      watcher.stop()
    }
  })

  test('the replica writes a heartbeat of itself', async () => {
    const ns = namespace()
    const store = new PostgresRouteTableStore({ client: server!, namespace: ns })
    const config = configurationStore()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })

    const watcher = watchRouteTable({
      store: config,
      routeTable: store,
      logger: createLogger({ level: 'silent' }),
      observer: new MetricsStore(),
      replicaId: 'replica-heartbeat',
      pollIntervalMs: 50,
      heartbeatIntervalMs: 50,
      heartbeatLifetimeMs: 5_000,
    })
    try {
      let heartbeats = await routeTable.listHeartbeats()
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        heartbeats = await routeTable.listHeartbeats()
        if (heartbeats.some((entry) => entry.replicaId === 'replica-heartbeat')) break
        await Bun.sleep(20)
      }
      // The replica says that it is there: the control plane shows it.
      expect(heartbeats.find((entry) => entry.replicaId === 'replica-heartbeat')).toBeDefined()
    } finally {
      watcher.stop()
    }
  })
  test('a store that cannot be reached keeps the last valid table', async () => {
    const ns = namespace()
    const store = new PostgresRouteTableStore({ client: server!, namespace: ns })
    const config = configurationStore()
    const observer = new MetricsStore()
    const routeTable = new PostgresRouteTableStore({ client: server!, namespace: ns })

    const written = await routeTable.writeRevision({
      table: TABLE,
      author: 'the-operator',
      expectedRevision: null,
      audit: {
        action: 'config.write',
        target: 'route-table',
        operator: 'the-operator',
        scope: 'config',
        address: '127.0.0.1',
        request: {},
        at: Date.now(),
      },
    })
    expect(written.ok).toBe(true)

    const watcher = watchRouteTable({
      store: config,
      routeTable: store,
      logger: createLogger({ level: 'silent' }),
      observer,
      replicaId: 'replica-1',
      pollIntervalMs: 50,
    })
    expect(await waitFor(() => config.snapshot !== null)).toBe(true)
    const routes = config.snapshot?.routes.map((route) => route.id)
    watcher.stop()

    // The store goes away: the deployment goes on serving the table it
    // has, and the failure is reported.
    const broken = new PostgresRouteTableStore({
      client: {
        query: async () => {
          throw new Error('the server is not reachable')
        },
        transaction: async () => {
          throw new Error('the server is not reachable')
        },
      },
      namespace: ns,
    })
    const failing = watchRouteTable({
      store: config,
      routeTable: broken,
      logger: createLogger({ level: 'silent' }),
      observer,
      replicaId: 'replica-1',
      pollIntervalMs: 50,
    })
    try {
      const failed = await waitFor(() => config.lastError !== null)
      expect(failed).toBe(true)
      expect(config.snapshot?.routes.map((route) => route.id)).toEqual(routes)
      // The failure is reported like a failed reload of the file.
      const metrics = await observer.render()
      expect(metrics).toContain('shuttle_config_reloads_total{result="failed"}')
    } finally {
      failing.stop()
    }
  })
})
