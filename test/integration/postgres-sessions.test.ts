/**
 * The store of the sessions in a Postgres server.
 *
 * The test proves that the store behaves like the one of Redis: the same
 * contract, the same lifetime, the same refusals.
 *
 * The contract itself is the one of `shared-state-conformance.ts`, and it
 * runs against this server as well: the tests here are the ones the
 * shared suite cannot state, the ones that are particular to Postgres.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresSessionStore } from '../../src/domains/authentication/adapters'
import { startPostgres, type PostgresTestServer } from './postgres-server'

let server: PostgresTestServer

/** The store under test, with its own prefix so the tests do not collide. */
function newStore(overrides: { ttlMs?: number; maxAgeMs?: number; touchIntervalMs?: number } = {}) {
  return new PostgresSessionStore({
    client: server,
    keyPrefix: 'test-sessions',
    ttlMs: overrides.ttlMs ?? 60_000,
    maxAgeMs: overrides.maxAgeMs ?? 0,
    touchIntervalMs: overrides.touchIntervalMs ?? 60_000,
  })
}

beforeAll(async () => {
  server = await startPostgres()
})

afterAll(async () => {
  await server.close()
})

describe('the sessions of a Postgres server', () => {
  test('the expiry is refreshed when the touch interval is over', async () => {
    const store = newStore({ ttlMs: 60_000, touchIntervalMs: 0 })
    const created = await store.create({ subject: 'carol' })
    const first = await store.get(created.id)
    expect(first).not.toBeNull()

    // The read refreshed the expiry of the session.
    await Bun.sleep(20)
    const second = await store.get(created.id)
    expect(second).not.toBeNull()
    expect(second!.expiresAt).toBeGreaterThan(first!.expiresAt)
  })

  test('the store knows that the server is there', async () => {
    const store = newStore()
    expect(await store.ping()).toBe(true)
  })

  test('the rows of the expired sessions are removed', async () => {
    const store = newStore({ ttlMs: 1_000, touchIntervalMs: 0 })
    const created = await store.create({ subject: 'grace' })
    await Bun.sleep(1_100)
    await store.get(created.id)

    const rows = await server.query<{ count: number }>(
      `SELECT count(*)::bigint AS count FROM shuttle.sessions WHERE id = $1`,
      [`test-sessions:s:${created.id}`]
    )
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(0)
  })
})
