import { describe, expect, test } from 'bun:test'
import { RedisSessionStore } from '../../src/domains/authentication/adapters'
import { createRedisClient, withRetries } from '../../src/platform/redis'

/**
 * The store of the sessions, against a real server.
 *
 * The contract of the shared store is about the races: a logout that
 * happens while a busy caller is read must not be undone, and the refresh
 * of the expiry must not reach beyond the maximum age of the session.
 * That contract is the one of `shared-state-conformance.ts`, and it runs
 * against this server as well: the tests here are the ones the shared
 * suite cannot state, the ones that are particular to Redis.
 *
 * The tests run when `SHUTTLE_TEST_REDIS_URL` names a server; without it
 * they are skipped, and the CI workflow runs them against a Redis service.
 */
const url = process.env.SHUTTLE_TEST_REDIS_URL
const describeRedis = url ? describe : describe.skip

describeRedis('the store of the sessions', () => {
  test('a session that was created is read by another replica', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-session-${Date.now()}`
    const first = new RedisSessionStore({ client, keyPrefix: prefix, ttlMs: 60_000 })
    const second = new RedisSessionStore({ client, keyPrefix: prefix, ttlMs: 60_000 })

    const created = await first.create({ subject: 'user-1', roles: ['admin'] })
    const read = await second.get(created.id)
    expect(read?.subject).toBe('user-1')
    expect(read?.roles).toEqual(['admin'])
    client.close()
  })

  test('a server that is not there denies the caller', async () => {
    const client = withRetries(createRedisClient({ url: 'redis://127.0.0.1:1/0' }))
    const store = new RedisSessionStore({ client, keyPrefix: 'test-down', ttlMs: 60_000 })
    await expect(store.get('anything')).rejects.toThrow()
    expect(await store.ping()).toBe(false)
    client.close()
  })
})
