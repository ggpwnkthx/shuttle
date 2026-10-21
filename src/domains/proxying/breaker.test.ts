import { describe, expect, test } from 'bun:test'
import { UpstreamBreaker } from './breaker'

describe('the breaker of the upstreams', () => {
  test('a breaker that is not active keeps the order of the file', () => {
    const breaker = new UpstreamBreaker({ failures: 0 })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      breaker.reportFailure('http://a:3000')
    }
    const order = breaker.order(['http://a:3000', 'http://b:3000'])
    expect(order.urls).toEqual(['http://a:3000', 'http://b:3000'])
    expect(order.skipped).toEqual([])
    expect(breaker.isOpen('http://a:3000')).toBe(false)
  })

  test('an upstream that failed is skipped after the threshold', () => {
    const breaker = new UpstreamBreaker({ failures: 3, cooldownMs: 30_000 })
    breaker.reportFailure('http://a:3000')
    breaker.reportFailure('http://a:3000')
    expect(breaker.isOpen('http://a:3000')).toBe(false)
    breaker.reportFailure('http://a:3000')
    expect(breaker.isOpen('http://a:3000')).toBe(true)
  })

  test('a skipped upstream is moved to the end of the list', () => {
    const breaker = new UpstreamBreaker({ failures: 1, cooldownMs: 30_000 })
    breaker.reportFailure('http://a:3000')
    const order = breaker.order(['http://a:3000', 'http://b:3000', 'http://c:3000'])
    expect(order.urls).toEqual(['http://b:3000', 'http://c:3000', 'http://a:3000'])
    expect(order.skipped).toEqual(['http://a:3000'])
  })

  test('the order of the list is kept inside the two groups', () => {
    const breaker = new UpstreamBreaker({ failures: 1, cooldownMs: 30_000 })
    breaker.reportFailure('http://b:3000')
    const order = breaker.order(['http://a:3000', 'http://b:3000', 'http://c:3000'])
    expect(order.urls).toEqual(['http://a:3000', 'http://c:3000', 'http://b:3000'])
  })

  test('a success resets the failures of an upstream', () => {
    const breaker = new UpstreamBreaker({ failures: 2, cooldownMs: 30_000 })
    breaker.reportFailure('http://a:3000')
    breaker.reportSuccess('http://a:3000')
    breaker.reportFailure('http://a:3000')
    expect(breaker.isOpen('http://a:3000')).toBe(false)
  })

  test('an upstream is tried again when its cooldown is over', () => {
    const breaker = new UpstreamBreaker({ failures: 1, cooldownMs: 1_000 })
    breaker.reportFailure('http://a:3000', 1_000)
    expect(breaker.isOpen('http://a:3000', 1_500)).toBe(true)
    expect(breaker.isOpen('http://a:3000', 2_100)).toBe(false)
    const order = breaker.order(['http://a:3000', 'http://b:3000'], 2_100)
    expect(order.urls).toEqual(['http://a:3000', 'http://b:3000'])
    expect(order.skipped).toEqual([])
  })

  test('a route with one upstream is never reordered', () => {
    const breaker = new UpstreamBreaker({ failures: 1, cooldownMs: 30_000 })
    breaker.reportFailure('http://a:3000')
    const order = breaker.order(['http://a:3000'])
    expect(order.urls).toEqual(['http://a:3000'])
    expect(order.skipped).toEqual([])
  })

  test('the breaker reports the failures, the openings and the recoveries', () => {
    const events: string[] = []
    const breaker = new UpstreamBreaker({
      failures: 2,
      cooldownMs: 30_000,
      onFailure: (url) => events.push(`failure:${url}`),
      onOpen: (url) => events.push(`open:${url}`),
      onRecovery: (url) => events.push(`recovery:${url}`),
    })
    breaker.reportFailure('http://a:3000')
    breaker.reportFailure('http://a:3000')
    breaker.reportSuccess('http://a:3000')
    expect(events).toEqual([
      'failure:http://a:3000',
      'failure:http://a:3000',
      'open:http://a:3000',
      'recovery:http://a:3000',
    ])
  })

  test('a success of an upstream that was never skipped is silent', () => {
    const events: string[] = []
    const breaker = new UpstreamBreaker({
      failures: 2,
      onRecovery: (url) => events.push(`recovery:${url}`),
    })
    breaker.reportSuccess('http://a:3000')
    expect(events).toEqual([])
  })

  test('the breaker forgets every upstream', () => {
    const breaker = new UpstreamBreaker({ failures: 1, cooldownMs: 30_000 })
    breaker.reportFailure('http://a:3000')
    expect(breaker.size).toBe(1)
    breaker.reset()
    expect(breaker.size).toBe(0)
    expect(breaker.isOpen('http://a:3000')).toBe(false)
  })
})
