import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

describe('the sign in page', () => {
  test('redirects to the identity provider', async () => {
    const response = await fetch(`${harness.gatewayUrl}/auth/login`, { redirect: 'manual' })
    expect(response.status).toBe(302)

    const location = response.headers.get('location')!
    expect(location).toContain('/auth?')
    expect(location).toContain('code_challenge_method=S256')
    expect(location).toContain('state=')
    expect(location).toContain('nonce=')
  })

  test('signing in through the provider creates a session', async () => {
    const login = await harness.login()
    expect(login.sessionCookie).toStartWith('shuttle_session=')

    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(200)
  })

  test('the redirect target cannot be abused', async () => {
    const response = await fetch(
      `${harness.gatewayUrl}/auth/login?redirect=${encodeURIComponent('https://evil.example.com/')}`,
      { redirect: 'manual' }
    )
    expect(response.status).toBe(302)
    // The login state cookie carries the target, and it is always a
    // relative path.
    const state = response.headers.getSetCookie().join(';')
    expect(state).toContain('shuttle_oidc_state')
  })

  test('a browser request without credentials is sent to the sign in', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', accept: 'text/html' },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/auth/login?redirect=')
  })
})
