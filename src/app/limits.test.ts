import { describe, expect, test } from 'bun:test'
import type { RateLimitDecision, RequestLimiter } from '../domains/rate-limiting'
import { checkLimits } from './limits'

/** A decision of a limiter. */
function decision(allowed: boolean, retryAfterMs = 0): RateLimitDecision {
  return { allowed, limit: 10, remaining: allowed ? 9 : 0, retryAfterMs }
}

/**
 * A limiter that records when its check was started and when it ended.
 *
 * The limiter waits for the gate, so the order of the starts and of the
 * ends is observable.
 */
function recorder(options: {
  results: { total: RateLimitDecision; global: RateLimitDecision; route: RateLimitDecision }
  gate?: Promise<void>
}) {
  const started: string[] = []
  const ended: string[] = []
  const make = (name: string, result: RateLimitDecision): RequestLimiter => ({
    disabled: false,
    max: result.limit,
    windowMs: 60_000,
    async check() {
      started.push(name)
      await options.gate
      ended.push(name)
      return result
    },
    async reset() {},
  })
  return {
    started,
    ended,
    limiters: {
      total: make('total', options.results.total),
      global: make('global', options.results.global),
      route: make('route', options.results.route),
    },
  }
}

/** The budgets of a request, with every window allowed. */
function allowed(): {
  total: RateLimitDecision
  global: RateLimitDecision
  route: RateLimitDecision
} {
  return { total: decision(true), global: decision(true), route: decision(true) }
}

describe('the budgets of a request', () => {
  test('the three budgets are counted at the same time', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const limiter = recorder({ results: allowed(), gate })
    const pending = checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    // The three checks are started before any of them ends: the shared
    // state is asked once instead of three times.
    await Promise.resolve()
    expect(limiter.started).toEqual(['total', 'global', 'route'])
    expect(limiter.ended).toEqual([])
    release()
    const outcome = await pending
    expect(outcome.refusal).toBeNull()
    expect(limiter.ended).toEqual(['total', 'global', 'route'])
  })

  test('a request that is allowed is not refused', async () => {
    const limiter = recorder({ results: allowed() })
    const outcome = await checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    expect(outcome.refusal).toBeNull()
  })

  test('the refusal that is reported is the first of the order of the specification', async () => {
    const limiter = recorder({
      results: { total: decision(false, 2500), global: decision(false), route: decision(false) },
    })
    const outcome = await checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    expect(outcome.refusal?.scope).toBe('total')
    expect(outcome.refusal?.decision.retryAfterMs).toBe(2500)
  })

  test('the budget of the caller is reported when the deployment is not exhausted', async () => {
    const limiter = recorder({
      results: { total: decision(true), global: decision(false, 1500), route: decision(false) },
    })
    const outcome = await checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    expect(outcome.refusal?.scope).toBe('global')
    expect(outcome.refusal?.decision.retryAfterMs).toBe(1500)
  })

  test('the budget of the route is reported when the others are not exhausted', async () => {
    const limiter = recorder({
      results: { total: decision(true), global: decision(true), route: decision(false, 500) },
    })
    const outcome = await checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    expect(outcome.refusal?.scope).toBe('route')
    expect(outcome.refusal?.decision.retryAfterMs).toBe(500)
  })

  test('every budget is counted, even when one of them refuses', async () => {
    const limiter = recorder({
      results: { total: decision(false), global: decision(true), route: decision(true) },
    })
    await checkLimits({
      ...limiter.limiters,
      totalKey: 'deployment:total',
      globalKey: 'caller:127.0.0.1',
      routeKey: 'route:api:127.0.0.1',
    })
    // The request was made: the budget of the caller is spent by the
    // requests that were made, and a flood that is refused at the scope of
    // the deployment is still counted against the caller.
    expect(limiter.started).toEqual(['total', 'global', 'route'])
    expect(limiter.ended).toEqual(['total', 'global', 'route'])
  })
})
