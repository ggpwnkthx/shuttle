import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'
import { rewriteLocation } from '../src/gateway/redirect'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    routes: ({ upstreamA, upstreamB }) => [
      {
        id: 'public-site',
        match: { host: 'public.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'workspace-api',
        match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
        upstream: upstreamB,
        auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
      },
      {
        id: 'pass-through',
        match: { host: 'pass.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'none' },
        redirects: 'pass',
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('the rewriting of a location', () => {
  const context = { upstreamOrigin: 'http://upstream-b:3000', mountPrefix: '/ws/abc/' }

  test('an absolute location of the upstream becomes relative', () => {
    expect(
      rewriteLocation('http://upstream-b:3000/login', context)
    ).toBe('/ws/abc/login')
  })

  test('the internal host of the upstream never reaches the client', () => {
    const rewritten = rewriteLocation('http://upstream-b:3000/login?next=1', context)
    expect(rewritten).not.toContain('upstream-b')
    expect(rewritten).toBe('/ws/abc/login?next=1')
  })

  test('a relative location keeps the prefix of the application', () => {
    expect(rewriteLocation('/login', context)).toBe('/ws/abc/login')
  })

  test('a location that already carries the prefix is left alone', () => {
    expect(rewriteLocation('/ws/abc/login', context)).toBe('/ws/abc/login')
    expect(rewriteLocation('/ws/abc', context)).toBe('/ws/abc')
  })

  test('a location to another host is left alone', () => {
    expect(rewriteLocation('https://example.com/login', context)).toBe(
      'https://example.com/login'
    )
    expect(rewriteLocation('//example.com/login', context)).toBe('//example.com/login')
  })

  test('a location without a path is left alone', () => {
    expect(rewriteLocation('?next=1', context)).toBe('?next=1')
    expect(rewriteLocation('#section', context)).toBe('#section')
    expect(rewriteLocation('', context)).toBe('')
  })

  test('an application at the root keeps its locations', () => {
    const root = { upstreamOrigin: 'http://upstream-a:3000', mountPrefix: '' }
    expect(rewriteLocation('/login', root)).toBe('/login')
    expect(rewriteLocation('http://upstream-a:3000/login', root)).toBe('/login')
  })
})

describe('the redirects of an upstream', () => {
  test('the internal host of the upstream is not leaked to the client', async () => {
    const login = await harness.login()
    const target = `${harness.upstreamB.url}/login`
    const response = await fetch(
      `${harness.gatewayUrl}/ws/${WORKSPACE_ID}/redirect?to=${encodeURIComponent(target)}`,
      {
        headers: { host: 'api.shuttle.test', cookie: login.cookie },
        redirect: 'manual',
      }
    )
    expect(response.status).toBe(302)
    const location = response.headers.get('location')!
    expect(location).not.toContain('upstream-b')
    expect(location).not.toContain(new URL(harness.upstreamB.url).port)
    // The prefix the application is mounted under is kept.
    expect(location).toBe(`/ws/${WORKSPACE_ID}/login`)
  })

  test('a redirect to another host is not touched', async () => {
    const target = 'https://example.com/login'
    const response = await fetch(
      `${harness.gatewayUrl}/redirect?to=${encodeURIComponent(target)}`,
      { headers: { host: 'public.shuttle.test' }, redirect: 'manual' }
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(target)
  })

  test('a route can forward the locations of the upstream unchanged', async () => {
    const target = `${harness.upstreamA.url}/login`
    const response = await fetch(
      `${harness.gatewayUrl}/redirect?to=${encodeURIComponent(target)}`,
      { headers: { host: 'pass.shuttle.test' }, redirect: 'manual' }
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(target)
  })
})
