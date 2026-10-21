import { describe, expect, test } from 'bun:test'
import {
  AuthenticationService,
  selectCredential,
  type OidcPort,
  type Principal,
  type VerifiedIdentity,
} from './index'
import { MemorySessionStore } from './adapters'

/** A provider that says what the test needs. */
function fakeProvider(options: {
  token?: VerifiedIdentity
  tokenError?: Error
  exchange?: VerifiedIdentity
}): OidcPort {
  return {
    async createAuthorizationRequest() {
      return {
        state: 'the-state',
        nonce: 'the-nonce',
        codeVerifier: 'the-verifier',
        codeChallenge: 'the-challenge',
      }
    },
    async authorizationUrl(params) {
      return `https://provider.example/authorize?state=${params.state}&nonce=${params.nonce}`
    },
    async exchangeCode() {
      if (!options.exchange) throw new Error('no exchange')
      return options.exchange
    },
    async verifyToken() {
      if (options.tokenError) throw options.tokenError
      if (!options.token) throw new Error('no token')
      return options.token
    },
  }
}

/** A service with a store of the sessions of the process. */
function service(
  options: {
    token?: VerifiedIdentity
    tokenError?: Error
    exchange?: VerifiedIdentity
    maxAgeMs?: number
  } = {}
): { service: AuthenticationService; sessions: MemorySessionStore } {
  const sessions = new MemorySessionStore({
    ttlMs: 60_000,
    maxAgeMs: options.maxAgeMs ?? 120_000,
    touchIntervalMs: 0,
  })
  return {
    sessions,
    service: new AuthenticationService({
      oidc: fakeProvider(options),
      sessions,
      secret: 'the-secret',
      cookies: { secure: true },
    }),
  }
}

describe('the choice of the credential', () => {
  test('the mode none accepts no credential', () => {
    expect(selectCredential('none', { authorization: 'Bearer token' })).toEqual({ kind: 'none' })
    expect(selectCredential('none', { sessionCookie: 'id' })).toEqual({ kind: 'none' })
  })

  test('the mode session uses the cookie and ignores the header', () => {
    expect(selectCredential('session', { sessionCookie: 'id' })).toEqual({
      kind: 'session',
      sessionId: 'id',
    })
    expect(selectCredential('session', { authorization: 'Bearer token' })).toEqual({ kind: 'none' })
  })

  test('the mode jwt uses the bearer token', () => {
    expect(selectCredential('jwt', { authorization: 'Bearer token' })).toEqual({
      kind: 'bearer',
      token: 'token',
    })
    expect(selectCredential('jwt', { sessionCookie: 'id' })).toEqual({ kind: 'none' })
  })

  test('a header that is not a bearer token is not a credential', () => {
    expect(selectCredential('jwt', { authorization: 'Basic dXNlcjpwYXNz' })).toEqual({
      kind: 'reject',
      reason: 'not_a_bearer',
    })
    expect(selectCredential('any', { authorization: 'Basic dXNlcjpwYXNz' })).toEqual({
      kind: 'reject',
      reason: 'not_a_bearer',
    })
    expect(selectCredential('jwt', { authorization: 'Bearer   ' })).toEqual({
      kind: 'reject',
      reason: 'empty_bearer',
    })
  })

  test('the mode any prefers the bearer token', () => {
    expect(selectCredential('any', { authorization: 'Bearer token', sessionCookie: 'id' })).toEqual(
      { kind: 'bearer', token: 'token' }
    )
  })

  test('the mode any falls back to the cookie when there is no header', () => {
    expect(selectCredential('any', { sessionCookie: 'id' })).toEqual({
      kind: 'session',
      sessionId: 'id',
    })
  })

  test('a request without a credential has none', () => {
    expect(selectCredential('any', {})).toEqual({ kind: 'none' })
    expect(selectCredential('jwt', {})).toEqual({ kind: 'none' })
    expect(selectCredential('session', {})).toEqual({ kind: 'none' })
  })
})

describe('the authentication of a request', () => {
  test('a bearer token authenticates the caller', async () => {
    const { service: auth } = service({
      token: { subject: 'user-1', email: 'user@example.com', roles: ['admin'] },
    })
    const outcome = await auth.authenticate({ kind: 'bearer', token: 'token' })
    expect(outcome?.principal.subject).toBe('user-1')
    expect(outcome?.principal.source).toBe('jwt')
    expect(outcome?.principal.roles).toEqual(['admin'])
  })

  test('an invalid bearer token is refused, the session of the browser is not used', async () => {
    const { service: auth, sessions } = service({ tokenError: new Error('invalid signature') })
    const created = await sessions.create({ subject: 'user-1' })
    const outcome = await auth.authenticate({ kind: 'bearer', token: 'invalid' })
    // The credential that the mode selected is invalid: the request is
    // refused, it does not fall back to the session of the browser.
    expect(outcome).toBeNull()
    expect(await sessions.get(created.id)).not.toBeNull()
  })

  test('a session cookie authenticates the caller and refreshes the cookie', async () => {
    const { service: auth, sessions } = service()
    const created = await sessions.create({ subject: 'user-1', roles: ['admin'] })
    const outcome = await auth.authenticate({ kind: 'session', sessionId: created.id })
    expect(outcome?.principal.subject).toBe('user-1')
    expect(outcome?.principal.source).toBe('session')
    expect(outcome?.session?.cookie.name).toBe('shuttle_session')
    expect(outcome?.session?.cookie.attributes.maxAge).toBeGreaterThan(0)
    expect(outcome?.session?.cookie.attributes.maxAge).toBeLessThanOrEqual(60)
  })

  test('a store that cannot be reached denies the caller', async () => {
    const auth = new AuthenticationService({
      oidc: fakeProvider({}),
      sessions: {
        ttlMs: 60_000,
        maxAgeMs: 0,
        touchIntervalMs: 0,
        async create() {
          throw new Error('the store is down')
        },
        async get() {
          throw new Error('the store is down')
        },
        async destroy() {},
        async destroyBySubject() {
          return 0
        },
        async ping() {
          return false
        },
        async close() {},
      },
      secret: 'the-secret',
      cookies: { secure: true },
    })
    expect(await auth.authenticate({ kind: 'session', sessionId: 'id' })).toBeNull()
  })

  test('a session that does not exist authenticates nobody', async () => {
    const { service: auth } = service()
    expect(await auth.authenticate({ kind: 'session', sessionId: 'nope' })).toBeNull()
  })
})

describe('the browser login', () => {
  test('the login carries the state and the challenge of the provider', async () => {
    const { service: auth } = service()
    const begun = await auth.beginLogin('/dashboard')
    expect(begun.authorizationUrl).toContain('state=the-state')
    expect(begun.authorizationUrl).toContain('nonce=the-nonce')
    expect(begun.stateCookie.name).toBe('shuttle_oidc_state')
    expect(begun.stateCookie.attributes.maxAge).toBe(600)
  })

  test('the login completes with the state of the cookie', async () => {
    const { service: auth, sessions } = service({
      exchange: { subject: 'user-1', email: 'user@example.com', roles: ['admin'] },
    })
    const begun = await auth.beginLogin('/dashboard')
    const outcome = await auth.completeLogin({
      params: new URLSearchParams({ code: 'the-code', state: 'the-state' }),
      stateCookie: begun.stateCookie.value,
    })
    expect(outcome.redirect).toBe('/dashboard')
    expect(outcome.principal.subject).toBe('user-1')
    expect(outcome.sessionCookie.name).toBe('shuttle_session')
    const stored = await sessions.get(outcome.sessionCookie.value)
    expect(stored?.subject).toBe('user-1')
  })

  test('a callback without the state of the cookie is refused', async () => {
    const { service: auth } = service({
      exchange: { subject: 'user-1', roles: [] },
    })
    const begun = await auth.beginLogin('/')
    await expect(
      auth.completeLogin({ params: new URLSearchParams({ code: 'the-code', state: 'the-state' }) })
    ).rejects.toThrow()
    expect(begun.stateCookie.name).toBe('shuttle_oidc_state')
  })

  test('a callback with another state is refused', async () => {
    const { service: auth } = service({
      exchange: { subject: 'user-1', roles: [] },
    })
    const begun = await auth.beginLogin('/')
    await expect(
      auth.completeLogin({
        params: new URLSearchParams({ code: 'the-code', state: 'another-state' }),
        stateCookie: begun.stateCookie.value,
      })
    ).rejects.toThrow(/state/)
  })

  test('an answer of the provider that carries an error is refused', async () => {
    const { service: auth } = service()
    await expect(
      auth.completeLogin({
        params: new URLSearchParams({ error: 'access_denied' }),
        stateCookie: 'x',
      })
    ).rejects.toThrow()
  })
})

describe('the logout', () => {
  test('the session is destroyed and the cookie is deleted', async () => {
    const { service: auth, sessions } = service()
    const created = await sessions.create({ subject: 'user-1' })
    const cookie = await auth.logout(created.id)
    expect(cookie.name).toBe('shuttle_session')
    expect(cookie.attributes.maxAge).toBe(0)
    expect(await sessions.get(created.id)).toBeNull()
  })

  test('a logout without a session is not an error', async () => {
    const { service: auth } = service()
    const cookie = await auth.logout(undefined)
    expect(cookie.attributes.maxAge).toBe(0)
  })
})

describe('the principal of a caller', () => {
  test('it carries the source of the credential', () => {
    const principal: Principal = { subject: 'user-1', roles: [], source: 'session' }
    expect(principal.source).toBe('session')
  })
})
