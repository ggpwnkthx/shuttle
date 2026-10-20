import { describe, expect, test } from 'bun:test'
import { buildUpstreamTarget, buildWebsocketTarget, rewriteLocation, upstreamOrigin } from './index'

describe('the target of a forwarded request', () => {
  test('the base path of the upstream is in front of the path of the request', () => {
    expect(buildUpstreamTarget('http://app:3000', '/ws/123', '?x=1')).toBe(
      'http://app:3000/ws/123?x=1'
    )
    expect(buildUpstreamTarget('http://app:3000/base/', '/ws/123', '?x=1')).toBe(
      'http://app:3000/base/ws/123?x=1'
    )
    expect(buildUpstreamTarget('http://app:3000/base', '/ws/123', '')).toBe(
      'http://app:3000/base/ws/123'
    )
  })

  test('the query string of the request replaces the one of the upstream', () => {
    expect(buildUpstreamTarget('http://app:3000/base', '/ws', '?a=1&b=2')).toBe(
      'http://app:3000/base/ws?a=1&b=2'
    )
  })

  test('the path is forwarded unchanged', () => {
    // The path arrives percent encoded (it is read from the url of the
    // request) and it is forwarded as it is: the target is not encoded
    // again.
    expect(buildUpstreamTarget('http://app:3000', '/ws/a%2Fb/c', '')).toBe(
      'http://app:3000/ws/a%2Fb/c'
    )
    expect(buildUpstreamTarget('http://app:3000', '/ws/a%20b', '')).toBe('http://app:3000/ws/a%20b')
    expect(buildUpstreamTarget('http://app:3000', '/ws/ä', '')).toBe('http://app:3000/ws/ä')
  })

  test('the fragment never reaches the upstream', () => {
    expect(buildUpstreamTarget('http://app:3000', '/ws', '')).not.toContain('#')
  })

  test('the url of a websocket uses the websocket scheme', () => {
    expect(buildWebsocketTarget('http://app:3000', '/ws', '')).toBe('ws://app:3000/ws')
    expect(buildWebsocketTarget('https://app:3000/base', '/ws', '?x=1')).toBe(
      'wss://app:3000/base/ws?x=1'
    )
  })
})

describe('the location of an answer of an upstream', () => {
  const origin = upstreamOrigin('http://upstream-b:3000')

  test('a location that names the upstream becomes relative', () => {
    expect(rewriteLocation('http://upstream-b:3000/login', { upstreamOrigin: origin })).toBe(
      '/login'
    )
    expect(
      rewriteLocation('http://upstream-b:3000/login?next=1#top', { upstreamOrigin: origin })
    ).toBe('/login?next=1#top')
  })

  test('a location that names another host is left alone', () => {
    expect(rewriteLocation('https://accounts.example.com/login', { upstreamOrigin: origin })).toBe(
      'https://accounts.example.com/login'
    )
  })

  test('a relative location is left alone', () => {
    expect(rewriteLocation('/login', { upstreamOrigin: origin })).toBe('/login')
    expect(rewriteLocation('login', { upstreamOrigin: origin })).toBe('login')
  })
})
