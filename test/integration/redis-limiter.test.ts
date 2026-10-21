import { describe, expect, test } from 'bun:test'
import { MemoryRateLimiter } from '../../src/domains/rate-limiting'
import { RedisRateLimiter } from '../../src/domains/rate-limiting/adapters'
import { createRedisClient, withRetries } from '../../src/platform/redis'

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
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-rl-${Date.now()}`
    const limiter = new RedisRateLimiter({ client, max: 100, windowMs: 60_000, keyPrefix: prefix })
    const now = Date.now()

    // Two "replicas" count at the same time in the same window.
    await Promise.all([
      ...Array.from({ length: 50 }, () => limiter.check('caller:1', now)),
      ...Array.from({ length: 50 }, () => limiter.check('caller:1', now)),
    ])

    const decision = await limiter.check('caller:1', now)
    // The hundred requests are counted: the hundred and first is the one
    // that is refused. A counter that lost an increment would let it
    // through, so the refusal proves that the counter is exact.
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
    client.close()
  })

  test('the window of a caller expires on its own', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-rl-${Date.now()}`
    const limiter = new RedisRateLimiter({ client, max: 1, windowMs: 1_000, keyPrefix: prefix })
    const now = Date.now()
    expect((await limiter.check('caller:ttl', now)).allowed).toBe(true)
    expect((await limiter.check('caller:ttl', now)).allowed).toBe(false)

    const keys = await client.keys(`${prefix}:rl:*`)
    expect(keys.length).toBeGreaterThan(0)
    const ttl = await client.ttl(keys[0]!)
    // The key lives as long as the window it holds, and a little longer.
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(2_500)
    client.close()
  })

  test('the window slides: the budget of the last milliseconds is the budget', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-rl-${Date.now()}`
    const limiter = new RedisRateLimiter({ client, max: 2, windowMs: 60_000, keyPrefix: prefix })
    const now = Date.now()
    // The two requests of the end of a fixed window and the two of the
    // beginning of the next one are four requests in a moment: a fixed
    // window lets them through, a sliding window does not.
    expect((await limiter.check('caller:slide', now - 1)).allowed).toBe(true)
    expect((await limiter.check('caller:slide', now - 1)).allowed).toBe(true)
    expect((await limiter.check('caller:slide', now)).allowed).toBe(false)
    expect((await limiter.check('caller:slide', now)).allowed).toBe(false)
    client.close()
  })

  test('the limiter of the shared state and the limiter of the memory agree', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const prefix = `test-rl-${Date.now()}`
    const shared = new RedisRateLimiter({
      client,
      max: 3,
      windowMs: 60_000,
      keyPrefix: prefix,
    })
    const memory = new MemoryRateLimiter({ max: 3, windowMs: 60_000 })
    const now = Date.now()

    // The same events, at the same moments, in the two limiters: the
    // script of the server and the code of the process have to count the
    // window in the same way.
    const moments = [now, now, now, now + 1, now + 30_000, now + 60_000, now + 60_001]
    for (const moment of moments) {
      const fromServer = await shared.check('caller:same', moment)
      const fromProcess = await memory.check('caller:same', moment)
      expect(fromServer.allowed).toBe(fromProcess.allowed)
      expect(fromServer.remaining).toBe(fromProcess.remaining)
      expect(fromServer.retryAfterMs).toBe(fromProcess.retryAfterMs)
    }
    client.close()
  })

  test('a server that is not there fails open', async () => {
    const client = withRetries(createRedisClient({ url: 'redis://127.0.0.1:1/0' }))
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
