import { describe, expect, test } from 'bun:test'
import { RedisRateLimiter, WINDOW_SCRIPT } from './adapters'
import {
  FallbackRateLimiter,
  MAX_TRACKED_KEYS,
  MemoryRateLimiter,
  TOTAL_RATE_LIMIT_KEY,
  bucketSizeMs,
  rateLimitKey,
  windowBucketCount,
} from './index'

describe('the scopes of the limiters', () => {
  test('the keys of the scopes are kept apart', () => {
    expect(rateLimitKey('global', { clientIp: '203.0.113.7' })).toBe('caller:203.0.113.7')
    expect(rateLimitKey('route', { clientIp: '203.0.113.7', routeId: 'workspace-api' })).toBe(
      'route:workspace-api:203.0.113.7'
    )
    expect(rateLimitKey('unmatched', { clientIp: '203.0.113.7' })).toBe('none:203.0.113.7')
    expect(rateLimitKey('login', { clientIp: '203.0.113.7' })).toBe('203.0.113.7')
  })

  test('the scope of a principal is keyed by the subject, not by the address', () => {
    expect(rateLimitKey('principal', { routeId: 'workspace-api', subject: 'user-1' })).toBe(
      'principal:workspace-api:user-1'
    )
    // Two callers behind the same address are two principals.
    expect(rateLimitKey('principal', { routeId: 'workspace-api', subject: 'user-2' })).not.toBe(
      rateLimitKey('principal', { routeId: 'workspace-api', subject: 'user-1' })
    )
  })

  test('the scope of the deployment has no address in it', () => {
    expect(TOTAL_RATE_LIMIT_KEY).toBe('deployment:total')
  })
})

describe('the window of a caller', () => {
  test('the window is divided into a bounded number of buckets', () => {
    expect(bucketSizeMs(60_000)).toBe(1_000)
    expect(windowBucketCount(60_000, 1_000)).toBe(60)
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

  test('the window slides: the budget of the last milliseconds is the budget', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 })
    // The request at the end of a fixed window and the request at the
    // beginning of the next one are two requests in one millisecond: a
    // fixed window lets the second one through, a sliding window does not.
    expect((await limiter.check('caller:1', 959_999)).allowed).toBe(true)
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(false)
  })

  test('a request leaves the window when its bucket leaves it', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    expect((await limiter.check('caller:1', 990_000)).allowed).toBe(false)
    // The bucket of the request leaves the window a window later.
    expect((await limiter.check('caller:1', 1_020_000)).allowed).toBe(true)
  })

  test('the number of tracked keys is bounded', async () => {
    const limiter = new MemoryRateLimiter({ max: 10, windowMs: 60_000 })
    for (let index = 0; index < 20_000; index++) {
      await limiter.check(`caller:${index}`, 960_000)
    }
    expect(limiter.size).toBeLessThanOrEqual(MAX_TRACKED_KEYS)
  })

  test('the window of a caller is not reset by a flood of other callers', async () => {
    const limiter = new MemoryRateLimiter({ max: 2, windowMs: 60_000 })
    await limiter.check('caller:victim', 960_000)
    await limiter.check('caller:victim', 960_000)
    // The table is filled with other keys: the window of the victim is
    // still there, so the third request of the victim is refused.
    for (let index = 0; index < MAX_TRACKED_KEYS + 10; index++) {
      await limiter.check(`caller:flood-${index}`, 960_000)
    }
    expect((await limiter.check('caller:victim', 960_000)).allowed).toBe(false)
  })

  test('a flood that does not fit the table is counted in one shared window', async () => {
    const limiter = new MemoryRateLimiter({ max: 5, windowMs: 60_000 })
    for (let index = 0; index < MAX_TRACKED_KEYS; index++) {
      await limiter.check(`caller:${index}`, 960_000)
    }
    // The table is full: the requests that do not fit are counted
    // together, so the flood is bounded by the same limit.
    let allowed = 0
    for (let index = 0; index < 20; index++) {
      if ((await limiter.check(`caller:overflow-${index}`, 960_000)).allowed) allowed += 1
    }
    expect(allowed).toBe(5)
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
  /** A client that answers like the server of the script does. */
  function fakeRedis(answer: unknown) {
    const calls: { key: string; args: (string | number)[] }[] = []
    return {
      calls,
      eval(_script: string, numkeys: number, ...keysAndArgs: (string | number)[]) {
        if (numkeys !== 1) throw new Error('unexpected script')
        calls.push({ key: String(keysAndArgs[0]), args: keysAndArgs.slice(1) })
        return Promise.resolve(answer)
      },
    }
  }

  test('the answer of the server is the answer of the limiter', async () => {
    const client = fakeRedis([0, 2, 60_000])
    const limiter = new RedisRateLimiter({
      client,
      max: 2,
      windowMs: 60_000,
    })
    const decision = await limiter.check('caller:1', 960_000)
    expect(decision.allowed).toBe(false)
    expect(decision.remaining).toBe(0)
    expect(decision.retryAfterMs).toBe(60_000)
  })

  test('an allowed request reports what is left of the budget', async () => {
    const client = fakeRedis([1, 1, 0])
    const limiter = new RedisRateLimiter({ client, max: 2, windowMs: 60_000 })
    const decision = await limiter.check('caller:1', 960_000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(1)
    expect(decision.retryAfterMs).toBe(0)
  })

  test('the key of a window does not carry a moment', async () => {
    const client = fakeRedis([1, 1, 0])
    const limiter = new RedisRateLimiter({ client, max: 10, windowMs: 60_000 })
    await limiter.check('caller:1', 960_000)
    // The buckets of the window carry the moment, so the key of a caller
    // is the same for the whole window.
    const key = client.calls[0]!.key
    expect(key).toContain(':rl:')
    expect(key).toMatch(/:rl:[0-9a-f]{32}$/)
  })

  test('the script carries the count and the expiry', async () => {
    const client = fakeRedis([1, 1, 0])
    const limiter = new RedisRateLimiter({ client, max: 10, windowMs: 60_000 })
    await limiter.check('caller:1', 960_000)
    // The buckets of the window are the fields of a hash, and the expiry
    // of the key is set with the count.
    expect(WINDOW_SCRIPT).toContain('HINCRBY')
    expect(WINDOW_SCRIPT).toContain('PEXPIRE')
    expect(WINDOW_SCRIPT).toContain('HGETALL')
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

  test('an answer that is not a window fails open', async () => {
    const limiter = new RedisRateLimiter({
      client: { eval: () => Promise.resolve('not a number') },
      max: 1,
      windowMs: 60_000,
    })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    const other = new RedisRateLimiter({
      client: { eval: () => Promise.resolve([1, 'not a number', 0]) },
      max: 1,
      windowMs: 60_000,
    })
    expect((await other.check('caller:1', 960_000)).allowed).toBe(true)
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

describe('the limiter that degrades with the shared state', () => {
  /** A client that answers like the server of the script does. */
  function fakeRedis(answer: unknown) {
    const calls: { key: string; args: (string | number)[] }[] = []
    return {
      calls,
      eval(_script: string, numkeys: number, ...keysAndArgs: (string | number)[]) {
        if (numkeys !== 1) throw new Error('unexpected script')
        calls.push({ key: String(keysAndArgs[0]), args: keysAndArgs.slice(1) })
        return Promise.resolve(answer)
      },
    }
  }

  /** A limiter that answers like the shared state does when it is down. */
  function degraded(max: number, windowMs: number) {
    return new FallbackRateLimiter({
      shared: new RedisRateLimiter({
        client: {
          eval() {
            return Promise.reject(new Error('the connection is closed'))
          },
        },
        max,
        windowMs,
      }),
      mode: 'local',
      scope: 'route',
    })
  }

  test('the window of the shared state is the one that counts', async () => {
    const client = fakeRedis([1, 1, 0])
    const limiter = new FallbackRateLimiter({
      shared: new RedisRateLimiter({ client, max: 2, windowMs: 60_000 }),
      mode: 'local',
      scope: 'route',
    })
    const decision = await limiter.check('caller:1', 960_000)
    expect(decision.allowed).toBe(true)
    // The shared state was asked, and the window of the process was not.
    expect(client.calls).toHaveLength(1)
    expect(limiter.degraded).toBe(false)
  })

  test('the request is counted in the process when the shared state is down', async () => {
    const limiter = degraded(2, 60_000)
    const now = 960_000
    expect((await limiter.check('caller:1', now)).allowed).toBe(true)
    expect((await limiter.check('caller:1', now)).allowed).toBe(true)
    // The budget of the process is the budget of the deployment: the third
    // request is refused, so the flood is bounded.
    const refused = await limiter.check('caller:1', now)
    expect(refused.allowed).toBe(false)
    expect(refused.degraded).toBe(true)
    expect(limiter.degraded).toBe(true)
  })

  test('the degradation is reported', async () => {
    const scopes: string[] = []
    const limiter = new FallbackRateLimiter({
      shared: new RedisRateLimiter({
        client: {
          eval() {
            return Promise.reject(new Error('the connection is closed'))
          },
        },
        max: 2,
        windowMs: 60_000,
      }),
      mode: 'local',
      scope: 'global',
      onFallback: (scope) => scopes.push(scope),
    })
    await limiter.check('caller:1', 960_000)
    expect(scopes).toEqual(['global'])
  })

  test('the recovery is reported when the shared state answers again', async () => {
    let degraded = true
    const recovered: string[] = []
    const limiter = new FallbackRateLimiter({
      shared: {
        max: 2,
        windowMs: 60_000,
        disabled: false,
        check() {
          if (degraded) {
            return Promise.resolve({
              allowed: true,
              limit: 2,
              remaining: 2,
              retryAfterMs: 0,
              degraded: true,
            })
          }
          return Promise.resolve({ allowed: true, limit: 2, remaining: 1, retryAfterMs: 0 })
        },
        reset: async () => undefined,
      },
      mode: 'local',
      scope: 'route',
      onRecovered: () => recovered.push('route'),
    })
    await limiter.check('caller:1', 960_000)
    expect(limiter.degraded).toBe(true)
    expect(recovered).toHaveLength(0)
    degraded = false
    await limiter.check('caller:1', 960_000)
    expect(limiter.degraded).toBe(false)
    expect(recovered).toEqual(['route'])
    // The recovery is reported once, and not on every request.
    await limiter.check('caller:1', 960_000)
    expect(recovered).toEqual(['route'])
  })

  test('the mode `open` allows everything, as the earlier releases did', async () => {
    const limiter = new FallbackRateLimiter({
      shared: new RedisRateLimiter({
        client: {
          eval() {
            return Promise.reject(new Error('the connection is closed'))
          },
        },
        max: 1,
        windowMs: 60_000,
      }),
      mode: 'open',
      scope: 'route',
    })
    for (let index = 0; index < 10; index++) {
      expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    }
  })

  test('the mode `closed` refuses everything', async () => {
    const limiter = new FallbackRateLimiter({
      shared: new RedisRateLimiter({
        client: {
          eval() {
            return Promise.reject(new Error('the connection is closed'))
          },
        },
        max: 1,
        windowMs: 60_000,
      }),
      mode: 'closed',
      scope: 'route',
    })
    const decision = await limiter.check('caller:1', 960_000)
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(60_000)
  })

  test('a limiter that throws is a degraded limiter', async () => {
    const limiter = new FallbackRateLimiter({
      shared: {
        max: 1,
        windowMs: 60_000,
        disabled: false,
        check() {
          return Promise.reject(new Error('the connection is closed'))
        },
        reset: async () => undefined,
      },
      mode: 'local',
      scope: 'route',
    })
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
    expect(limiter.degraded).toBe(true)
  })

  test('a limiter that does not limit anything does not degrade', async () => {
    const limiter = new FallbackRateLimiter({
      shared: new MemoryRateLimiter({ max: 0, windowMs: 60_000 }),
      mode: 'local',
      scope: 'route',
    })
    expect(limiter.disabled).toBe(true)
    expect((await limiter.check('caller:1', 960_000)).allowed).toBe(true)
  })
})
