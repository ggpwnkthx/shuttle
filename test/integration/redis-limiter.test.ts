import { describe, expect, test } from 'bun:test'
import { RedisRateLimiter } from '../../src/domains/rate-limiting/adapters'
import { createRedisClient } from '../../src/platform/redis'

/**
 * The limiter of the shared state, against a real server.
 *
 * The counters of the replicas have to be exact: a counter that loses an
 * increment lets a caller make more requests than the budget allows. The
 * tests run when `SHUTTLE_TEST_REDIS_URL` names a server; without it they
 * are skipped, and the CI workflow runs them against a Redis service.
 */
const url = process.env.SHUTTLE_TEST_REDIS_URL
const describeRedis = url ? describe : describe.skip

describeRedis('the limiter of the shared state', () => {
  test('the counter of a window is exact when the requests are concurrent', async () => {
    const client = createRedisClient({ url: url! })
    const prefix = `test-rl-${Date.now()}`
    const limiter = new RedisRateLimiter({ client, max: 1000, windowMs: 60_000, keyPrefix: prefix })
    const now = Date.now()

    // Two "replicas" count at the same time in the same window.
    await Promise.all([
      ...Array.from({ length: 50 }, () => limiter.check('caller:1', now)),
      ...Array.from({ length: 50 }, () => limiter.check('caller:1', now)),
    ])

    const decision = await limiter.check('caller:1', now)
    // The hundred requests are counted: the hundred and first is the one
    // that is refused, and the counter is exact.
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
    client.close()
  })

  test('the window of a caller expires on its own', async () => {
    const client = createRedisClient({ url: url! })
    const prefix = `test-rl-${Date.now()}`
    const limiter = new RedisRateLimiter({ client, max: 1, windowMs: 1_000, keyPrefix: prefix })
    const now = Date.now()
    expect((await limiter.check('caller:ttl', now)).allowed).toBe(true)
    expect((await limiter.check('caller:ttl', now)).allowed).toBe(false)

    const keys = await client.keys(`${prefix}:rl:*`)
    expect(keys.length).toBeGreaterThan(0)
    const ttl = await client.ttl(keys[0]!)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1_500)
    client.close()
  })

  test('a server that is not there fails open', async () => {
    const client = createRedisClient({ url: 'redis://127.0.0.1:1/0' })
    const errors: unknown[] = []
    const limiter = new RedisRateLimiter({
      client,
      max: 1,
      windowMs: 60_000,
      onError: (error) => errors.push(error),
    })
    const decision = await limiter.check('caller:down', Date.now())
    expect(decision.allowed).toBe(true)
    expect(errors.length).toBeGreaterThan(0)
    client.close()
  })
})
