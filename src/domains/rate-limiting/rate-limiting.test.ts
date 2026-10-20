import { describe, expect, test } from 'bun:test'
import { COUNT_SCRIPT, RedisRateLimiter } from './adapters'
import { MemoryRateLimiter, rateLimitKey, retryAfterMs, windowStart } from './index'

describe('the scopes of the limiters', () => {
  test('the keys of the scopes are kept apart', () => {
    expect(rateLimitKey('global', { clientIp: '203.0.113.7' })).toBe('caller:203.0.113.7')
    expect(rateLimitKey('route', { clientIp: '203.0.113.7', routeId: 'workspace-api' })).toBe(
      'route:workspace-api:203.0.113.7'
    )
    expect(rateLimitKey('unmatched', { clientIp: '203.0.113.7' })).toBe('none:203.0.113.7')
    expect(rateLimitKey('login', { clientIp: '203.0.113.7' })).toBe('203.0.113.7')
  })
})

describe('the window of a caller', () => {
  test('the window starts at a moment every replica can compute', () => {
    expect(windowStart(960_000, 60_000)).toBe(960_000)
    expect(windowStart(1_059_999, 60_000)).toBe(1_020_000)
    expect(windowStart(1_020_000, 60_000)).toBe(1_020_000)
  })

  test('the time that is left is the time that is really left', () => {
    expect(retryAfterMs(960_000, 60_000)).toBe(60_000)
    expect(retryAfterMs(990_000, 60_000)).toBe(30_000)
    expect(retryAfterMs(1_019_999, 60_000)).toBe(1)
  })
})

describe('the limiter of the memory', () => {
  test('a limit of zero disables the limiter', async () => {
    const limiter = new MemoryRateLimiter({ max: 0, windowMs: 60_000 })
    expect(limiter.disabled).toBe(true)
    for (let index = 0; index < 100; index++) {
      expect((await limiter.check('caller:1')).allowed).toBe(true)
    }
  })

  test('the requests over the limit are refused', async () => {
    const limiter = new MemoryRateLimiter({ max: 2, windowMs: 60_000 })
    const now = 960_000
    expect((await limiter.check('caller:1', now)).allowed).toBe(true)
    expect((await limiter.check('caller:1', now)).allowed).toBe(true)
    const refused = await limiter.check('caller:1', now)
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    expect(refused.retryAfterMs).toBe(60_000)
  })

  test('the budget of a caller is not the budget of another one', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    expect((await limiter.check('caller:2', 960_000)).allowed).toBe(true)
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(false)
  })

  test('a new window starts when the old one is over', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    expect((await limiter.check('caller:1', 990_000)).allowed).toBe(false)
    // The next window starts at the next boundary of the clock.
    expect((await limiter.check('caller:1', 1_020_000)).allowed).toBe(true)
  })

  test('the number of tracked keys is bounded', async () => {
    const limiter = new MemoryRateLimiter({ max: 10, windowMs: 60_000 })
    for (let index = 0; index < 20_000; index++) {
      await limiter.check(`caller:${index}`, 960_000)
    }
    expect(limiter.size).toBeLessThanOrEqual(10_000)
  })

  test('a request that is over the limit is not counted', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 })
    await limiter.check('caller:1', 960_000)
    await limiter.check('caller:1', 960_000)
    await limiter.check('caller:1', 960_000)
    // The window was not pushed further away by the refused requests.
    expect((await limiter.check('caller:1', 1_020_000)).allowed).toBe(true)
  })
})

describe('the limiter of the shared state', () => {
  /** A client that counts in a map, like a server would. */
  function fakeRedis() {
    const counters = new Map<string, number>()
    return {
      counters,
      eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]) {
        if (!script.includes('INCR') || numkeys !== 1) throw new Error('unexpected script')
        const key = String(keysAndArgs[0])
        const count = (counters.get(key) ?? 0) + 1
        counters.set(key, count)
        return Promise.resolve(count)
      },
    }
  }

  test('the requests over the limit are refused', async () => {
    const client = fakeRedis()
    const limiter = new RedisRateLimiter({
      client,
      max: 2,
      windowMs: 60_000,
    })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    const refused = await limiter.check('caller:1', 960_000)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBe(60_000)
  })

  test('the counter and the expiry are one operation', async () => {
    const client = fakeRedis()
    const limiter = new RedisRateLimiter({ client, max: 10, windowMs: 60_000 })
    await limiter.check('caller:1', 960_000)
    const keys = [...client.counters.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toContain(':rl:')
    expect(keys[0]).toContain(':960000')
    // The script carries the expiry of the window with the counter.
    expect(COUNT_SCRIPT).toContain('INCR')
    expect(COUNT_SCRIPT).toContain('PEXPIRE')
  })

  test('a server that cannot be reached fails open', async () => {
    const errors: unknown[] = []
    const limiter = new RedisRateLimiter({
      client: {
        eval() {
          return Promise.reject(new Error('the connection is closed'))
        },
      },
      max: 1,
      windowMs: 60_000,
      onError: (error) => errors.push(error),
    })
    const decision = await limiter.check('caller:1', 960_000)
    expect(decision.allowed).toBe(true)
    expect(errors).toHaveLength(1)
  })

  test('an answer that is not a number fails open', async () => {
    const limiter = new RedisRateLimiter({
      client: { eval: () => Promise.resolve('not a number') },
      max: 1,
      windowMs: 60_000,
    })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
  })

  test('a limit of zero disables the limiter', async () => {
    const limiter = new RedisRateLimiter({
      client: {
        eval() {
          throw new Error('the limiter is disabled, it must not talk to the server')
        },
      },
      max: 0,
      windowMs: 60_000,
    })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
  })
})
