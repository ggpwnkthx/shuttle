import { describe, expect, test } from 'bun:test'
import { resolveForwardingContext } from './context'

/**
 * The address of the caller.
 *
 * The gateway is behind a proxy, and the proxy reports the address of the
 * caller in `x-forwarded-for`. A client can send that header itself, so
 * the address the gateway attributes to the caller is only the one the
 * trusted proxies wrote.
 */

/** The context of a request that comes from a trusted proxy. */
function context(options: {
  peerAddress?: string
  forwardedFor?: string
  hops?: number
  trustedProxies?: string[]
}) {
  const headers = new Headers()
  if (options.forwardedFor !== undefined) headers.set('x-forwarded-for', options.forwardedFor)
  headers.set('host', 'api.example.com')
  return resolveForwardingContext({
    peerAddress: options.peerAddress ?? '10.0.0.5',
    headers,
    trustedProxies: options.trustedProxies ?? ['10.0.0.0/8'],
    trustedProxyHops: options.hops,
    externalProto: 'http',
  })
}

describe('the address of the caller', () => {
  test('a peer that is not a trusted proxy is the caller', () => {
    const forwarding = context({
      peerAddress: '198.51.100.9',
      forwardedFor: '203.0.113.7',
      trustedProxies: ['10.0.0.0/8'],
    })
    expect(forwarding.peerTrusted).toBe(false)
    expect(forwarding.clientIp).toBe('198.51.100.9')
    expect(forwarding.chain).toEqual(['198.51.100.9'])
  })

  test('the proxy reports the address it observed', () => {
    const forwarding = context({ forwardedFor: '203.0.113.7' })
    expect(forwarding.clientIp).toBe('203.0.113.7')
    expect(forwarding.chain).toEqual(['203.0.113.7', '10.0.0.5'])
  })

  test('a client cannot choose the address the gateway attributes to it', () => {
    // The client sends its own header and the proxy appends the address it
    // observed. The entry the client wrote is on the left, and it is
    // dropped.
    const forwarding = context({ forwardedFor: '192.0.2.66, 203.0.113.7' })
    expect(forwarding.clientIp).toBe('203.0.113.7')
    expect(forwarding.chain).toEqual(['203.0.113.7', '10.0.0.5'])
  })

  test('a client whose address is inside a trusted range cannot choose it either', () => {
    // The address of the caller is inside the range of the trusted
    // proxies: the gateway does not walk the chain by range, it counts the
    // proxies, so the entry the client wrote is still dropped.
    const forwarding = context({ forwardedFor: '192.0.2.66, 10.0.0.5' })
    expect(forwarding.clientIp).toBe('10.0.0.5')
    expect(forwarding.chain).toEqual(['10.0.0.5', '10.0.0.5'])
  })

  test('the number of the proxies decides which entry is the caller', () => {
    const chain = '192.0.2.1, 203.0.113.7, 10.0.0.4'
    expect(context({ forwardedFor: chain, hops: 1 }).clientIp).toBe('10.0.0.4')
    expect(context({ forwardedFor: chain, hops: 2 }).clientIp).toBe('203.0.113.7')
    expect(context({ forwardedFor: chain, hops: 3 }).clientIp).toBe('192.0.2.1')
  })

  test('a chain that is shorter than the number of the proxies is not trusted', () => {
    // The gateway cannot know the caller: the peer is the answer.
    const forwarding = context({ forwardedFor: '203.0.113.7', hops: 2 })
    expect(forwarding.clientIp).toBe('10.0.0.5')
    expect(forwarding.chain).toEqual(['10.0.0.5'])
  })

  test('a request without a chain is the peer', () => {
    const forwarding = context({})
    expect(forwarding.clientIp).toBe('10.0.0.5')
    expect(forwarding.chain).toEqual(['10.0.0.5'])
  })

  test('the number of the proxies is at least one', () => {
    const forwarding = context({ forwardedFor: '203.0.113.7', hops: 0 })
    expect(forwarding.clientIp).toBe('203.0.113.7')
  })

  test('a number of the proxies that cannot be understood is one', () => {
    const forwarding = context({ forwardedFor: '203.0.113.7', hops: Number.NaN })
    expect(forwarding.clientIp).toBe('203.0.113.7')
  })
})
