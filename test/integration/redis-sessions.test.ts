import { describe, expect, test } from 'bun:test'
import { RedisSessionStore } from '../../src/domains/authentication/adapters'
import { createRedisClient, withRetries } from '../../src/platform/redis'

/**
 * The store of the sessions, against a real server.
 *
 * The contract of the shared store is about the races: a logout that
 * happens while a busy caller is read must not be undone, and the refresh
 * of the expiry must not reach beyond the maximum age of the session.
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

  test('a logout is not undone by a read that happens at the same time', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-session-${Date.now()}`
    const store = new RedisSessionStore({ client, keyPrefix: prefix, ttlMs: 60_000 })

    for (let round = 0; round < 20; round++) {
      const created = await store.create({ subject: 'user-1' })
      // The logout and the read of a busy caller happen at the same time.
      await Promise.all([store.destroy(created.id), store.get(created.id)])
      // The session stays gone: the refresh of the expiry never recreates
      // a session that was deleted.
      expect(await store.get(created.id)).toBeNull()
    }
    client.close()
  })

  test('the refresh never reaches beyond the maximum age of the session', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-session-${Date.now()}`
    const store = new RedisSessionStore({
      client,
      keyPrefix: prefix,
      ttlMs: 60_000,
      maxAgeMs: 300,
      touchIntervalMs: 0,
    })
    const created = await store.create({ subject: 'user-1' })
    expect(created.absoluteExpiresAt).toBeDefined()

    await Bun.sleep(150)
    const refreshed = await store.get(created.id)
    expect(refreshed).not.toBeNull()
    // The idle lifetime was 60 seconds, the maximum age is 300 milliseconds:
    // the refresh is capped by the maximum age.
    expect(refreshed!.expiresAt).toBeLessThanOrEqual(created.absoluteExpiresAt!)

    await Bun.sleep(250)
    // The session is over: it is older than its maximum age, whatever the
    // activity of the caller was.
    expect(await store.get(created.id)).toBeNull()
    client.close()
  })

  test('the expiry is not refreshed before the interval is over', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-session-${Date.now()}`
    const store = new RedisSessionStore({
      client,
      keyPrefix: prefix,
      ttlMs: 60_000,
      touchIntervalMs: 5_000,
    })
    const created = await store.create({ subject: 'user-1' })
    const first = await store.get(created.id)
    await Bun.sleep(50)
    const second = await store.get(created.id)
    expect(second!.expiresAt).toBe(first!.expiresAt)
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
