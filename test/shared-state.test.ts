import { describe, expect, test } from 'bun:test'
import { RedisRateLimiter, RateLimiter } from '../src/gateway/ratelimit'
import { RedisDecisionCache, MemoryDecisionCache } from '../src/auth/decision-cache'
import { createRedisClient, isRedisUrl, runWithRetry } from '../src/redis/client'

/**
 * The state the replicas share.
 *
 * A deployment with more than one replica needs the rate limits and the
 * cached access decisions in a place every replica reaches: a limiter that
 * lives in the memory of a process allows every replica its own budget.
 *
 * The tests below run against a real Redis server when the variable
 * `SHUTTLE_TEST_REDIS_URL` names one, and against a server that is not
 * there otherwise. The second case is the interesting one for the
 * availability: the limiter fails open and the cache is skipped.
 */

const REDIS_URL = process.env.SHUTTLE_TEST_REDIS_URL

function client(url: string): Bun.RedisClient {
  return createRedisClient({ url })
}

describe('the shared state', () => {
  test('a redis url is recognised', () => {
    expect(isRedisUrl('redis://127.0.0.1:6379/0')).toBe(true)
    expect(isRedisUrl('rediss://:password@host:6379/0')).toBe(true)
    expect(isRedisUrl('memory://local')).toBe(false)
    expect(isRedisUrl(undefined)).toBe(false)
  })

  test('the limiter of a process is not shared', async () => {
    const first = new RateLimiter({ max: 2, windowMs: 60_000 })
    const second = new RateLimiter({ max: 2, windowMs: 60_000 })
    expect((await first.check('caller')).allowed).toBe(true)
    expect((await first.check('caller')).allowed).toBe(true)
    expect((await first.check('caller')).allowed).toBe(false)
    // The second limiter has its own window: the budget of a caller is per
    // process, which is why a deployment with several replicas needs the
    // shared implementation.
    expect((await second.check('caller')).allowed).toBe(true)
  })

  test('the shared limiter counts in the same window for every replica', async () => {
    if (!REDIS_URL) {
      console.warn('SHUTTLE_TEST_REDIS_URL is not set, the shared state is not tested')
      return
    }
    const first = client(REDIS_URL)
    const second = client(REDIS_URL)
    const prefix = `shuttle-test-${Date.now()}`
    const a = new RedisRateLimiter({ max: 2, windowMs: 60_000, client: first, keyPrefix: prefix })
    const b = new RedisRateLimiter({ max: 2, windowMs: 60_000, client: second, keyPrefix: prefix })
    try {
      expect((await a.check('caller')).allowed).toBe(true)
      // The second replica counts in the same window.
      expect((await b.check('caller')).allowed).toBe(true)
      expect((await a.check('caller')).allowed).toBe(false)
      // A caller of its own is not affected by the window of the other one.
      expect((await b.check('another-caller')).allowed).toBe(true)
    } finally {
      first.close()
      second.close()
    }
  })

  test('the shared limiter fails open when the server is not there', async () => {
    // Nothing listens on this port. A limiter that refuses every request
    // when the cache has a hiccup would turn the hiccup into an outage.
    const unreachable = client('redis://127.0.0.1:9')
    const errors: unknown[] = []
    const limiter = new RedisRateLimiter({
      max: 1,
      windowMs: 60_000,
      client: unreachable,
      keyPrefix: 'shuttle-test',
      onError: (error) => errors.push(error),
    })
    try {
      const decision = await limiter.check('caller')
      expect(decision.allowed).toBe(true)
      // The failure is reported, so an operator sees that the limits of the
      // deployment are not enforced.
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      unreachable.close()
    }
  })

  test('the shared cache keeps a decision between the replicas', async () => {
    if (!REDIS_URL) {
      console.warn('SHUTTLE_TEST_REDIS_URL is not set, the shared state is not tested')
      return
    }
    const first = client(REDIS_URL)
    const second = client(REDIS_URL)
    const prefix = `shuttle-test-${Date.now()}`
    const a = new RedisDecisionCache({ client: first, keyPrefix: prefix })
    const b = new RedisDecisionCache({ client: second, keyPrefix: prefix })
    try {
      expect(await b.get('decision')).toBeNull()
      await a.set('decision', { allow: true, reason: 'allowed', decidedAt: Date.now() }, 60_000)
      const cached = await b.get('decision')
      expect(cached?.allow).toBe(true)
      expect(cached?.reason).toBe('allowed')
    } finally {
      first.close()
      second.close()
    }
  })

  test('the shared cache is skipped when the server is not there', async () => {
    const unreachable = client('redis://127.0.0.1:9')
    const cache = new RedisDecisionCache({ client: unreachable, keyPrefix: 'shuttle-test' })
    try {
      // A cache that is not available never changes the answer of a
      // request: the decision is asked for again.
      expect(await cache.get('decision')).toBeNull()
      await cache.set('decision', { allow: true, reason: 'allowed', decidedAt: Date.now() }, 60_000)
      expect(await cache.get('decision')).toBeNull()
    } finally {
      unreachable.close()
    }
  })

  test('the cache of a process keeps the decisions in memory', async () => {
    const cache = new MemoryDecisionCache()
    expect(await cache.get('decision')).toBeNull()
    await cache.set('decision', { allow: false, reason: 'denied', decidedAt: Date.now() }, 60_000)
    expect((await cache.get('decision'))?.allow).toBe(false)
    await cache.delete('decision')
    expect(await cache.get('decision')).toBeNull()
  })

  test('a command is retried while the connection is not established', async () => {
    let attempts = 0
    const value = await runWithRetry(async () => {
      attempts += 1
      if (attempts < 2) {
        const error = new Error('connection is closed')
        throw error
      }
      return 'ok'
    }, 3)
    expect(value).toBe('ok')
    expect(attempts).toBe(2)
  })

  test('an error that is not a connection error is not retried', async () => {
    let attempts = 0
    await expect(
      runWithRetry(async () => {
        attempts += 1
        throw new Error('the command was rejected')
      }, 3)
    ).rejects.toThrow(/rejected/)
    expect(attempts).toBe(1)
  })
})
