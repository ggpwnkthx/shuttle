import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { deriveIdentityKey, signIdentity, verifyIdentity } from '../src/auth/identity'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The signature of the identity headers.
 *
 * The identity the gateway writes into the headers of a request is only
 * trustworthy when the request went through the gateway. The signature
 * makes that assumption checkable.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

async function upstreamEcho(
  headers: Record<string, string>,
  path = `/ws/${WORKSPACE_ID}/`
): Promise<{
  headers: Record<string, string>
  target: string
}> {
  const response = await fetch(`${harness.gatewayUrl}${path}`, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as { headers: Record<string, string>; target: string }
}

/**
 * The claims an upstream reconstructs from the headers it received.
 *
 * The upstream knows the path and the query of the request it received,
 * and the host the client used is in `x-forwarded-host`.
 */
function claimsOf(body: { headers: Record<string, string> }): {
  subject: string
  email?: string
  roles: string[]
  workspaceId?: string
} {
  return {
    subject: body.headers['x-shuttle-user']!,
    email: body.headers['x-shuttle-email'],
    roles: body.headers['x-shuttle-roles']!.split(','),
    workspaceId: body.headers['x-shuttle-workspace'],
  }
}

/** The request as the upstream received it. */
function requestOf(body: { headers: Record<string, string>; target: string }): {
  method: string
  path: string
  query: string
  host: string
} {
  const index = body.target.indexOf('?')
  const path = index === -1 ? body.target : body.target.slice(0, index)
  const query = index === -1 ? '' : body.target.slice(index)
  return {
    method: 'GET',
    path,
    query,
    host: body.headers['x-forwarded-host']!,
  }
}

describe('the identity signature', () => {
  test('the identity of a request is signed', async () => {
    const login = await harness.login()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      cookie: login.cookie,
    })
    expect(body.headers['x-shuttle-user']).toBeDefined()
    expect(body.headers['x-shuttle-signature']).toMatch(/^v3=[0-9a-f]{64}$/)
  })

  test('the signature can be verified with the shared secret', async () => {
    const login = await harness.login()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      cookie: login.cookie,
    })
    const key = deriveIdentityKey('test-session-secret')
    // The upstream verifies the signature with the values it received: the
    // target of the request and the host the client used.
    const verified = verifyIdentity(
      claimsOf(body),
      requestOf(body),
      key,
      body.headers['x-shuttle-signature']
    )
    expect(verified).toBe(true)
  })

  test('the signature belongs to the request it was written for', async () => {
    const login = await harness.login()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      cookie: login.cookie,
    })
    const key = deriveIdentityKey('test-session-secret')
    const claims = claimsOf(body)
    const request = requestOf(body)
    // The signature of a request cannot be used for another one.
    expect(
      verifyIdentity(claims, { ...request, method: 'POST' }, key, body.headers['x-shuttle-signature'])
    ).toBe(false)
    expect(
      verifyIdentity(claims, { ...request, path: '/ws/other/' }, key, body.headers['x-shuttle-signature'])
    ).toBe(false)
  })

  test('the signature is bound to the query string of the request', async () => {
    const login = await harness.login()
    const body = await upstreamEcho(
      {
        host: 'api.shuttle.test',
        cookie: login.cookie,
      },
      `/ws/${WORKSPACE_ID}/?admin=true`
    )
    const key = deriveIdentityKey('test-session-secret')
    const claims = claimsOf(body)
    const request = requestOf(body)
    expect(request.query).toBe('?admin=true')
    expect(verifyIdentity(claims, request, key, body.headers['x-shuttle-signature'])).toBe(true)
    // A signature of a request without a query string cannot be replayed
    // onto a request with one.
    expect(
      verifyIdentity(claims, { ...request, query: '' }, key, body.headers['x-shuttle-signature'])
    ).toBe(false)
  })

  test('the signature is bound to the host of the request', async () => {
    const login = await harness.login()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      cookie: login.cookie,
    })
    const key = deriveIdentityKey('test-session-secret')
    const claims = claimsOf(body)
    const request = requestOf(body)
    expect(verifyIdentity(claims, request, key, body.headers['x-shuttle-signature'])).toBe(true)
    expect(
      verifyIdentity(claims, { ...request, host: 'other.shuttle.test' }, key, body.headers['x-shuttle-signature'])
    ).toBe(false)
  })

  test('a caller cannot forge the signature', async () => {
    const login = await harness.login()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      cookie: login.cookie,
      // The gateway removes the identity headers of the caller, the
      // signature included.
      'x-shuttle-user': 'attacker',
      'x-shuttle-signature': 'v3=' + '0'.repeat(64),
    })
    expect(body.headers['x-shuttle-user']).not.toBe('attacker')
    expect(body.headers['x-shuttle-signature']).not.toBe('v3=' + '0'.repeat(64))
  })

  test('a request without a caller is not signed', async () => {
    const body = await upstreamEcho({ host: 'public.shuttle.test' })
    expect(body.headers['x-shuttle-signature']).toBeUndefined()
  })

  test('the signature of a token is written as well', async () => {
    const token = await harness.token()
    const body = await upstreamEcho({
      host: 'api.shuttle.test',
      authorization: `Bearer ${token}`,
    })
    expect(body.headers['x-shuttle-signature']).toMatch(/^v3=[0-9a-f]{64}$/)
  })
})

describe('the signing key', () => {
  test('the key of the signature is not the secret itself', () => {
    const key = deriveIdentityKey('a-secret')
    expect(key.toString('hex')).not.toBe('a-secret')
    expect(deriveIdentityKey('a-secret').equals(key)).toBe(true)
    expect(deriveIdentityKey('another-secret').equals(key)).toBe(false)
  })

  test('the signature is stable', () => {
    const key = deriveIdentityKey('a-secret')
    const claims = { subject: 'alice', roles: ['member'] }
    const request = { method: 'GET', path: '/ws/1/', query: '', host: 'api.shuttle.test' }
    expect(signIdentity(claims, request, key)).toBe(signIdentity(claims, request, key))
  })
})
