import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { serializeSigned } from 'hono/utils/cookie'
import { AuthService } from '../src/auth/service'
import { OidcError } from '../src/auth/oidc'
import {
  createSessionStore,
  MemorySessionStore,
  RedisSessionStore,
  SessionStoreError,
  type SessionStore,
} from '../src/auth/session'

const REDIS_URL = process.env.SHUTTLE_TEST_REDIS_URL

/** The signed login state the callback of a browser login carries. */
const stateCookie = async (): Promise<string> => {
  const cookie = await serializeSigned(
    'shuttle_oidc_state',
    JSON.stringify({
      state: 'state',
      nonce: 'nonce',
      verifier: 'verifier',
      redirect: '/',
      exp: Date.now() + 60_000,
    }),
    'test-secret'
  )
  // The value of the cookie, without the name and the attributes.
  return cookie.slice(cookie.indexOf('=') + 1).split(';')[0]!
}

/**
 * The same expectations are checked against every backend, so a new provider
 * only has to pass this suite to be usable.
 */
function sessionContract(
  name: string,
  create: (options?: { touchIntervalMs?: number }) => SessionStore | Promise<SessionStore>
): void {
  describe(name, () => {
    test('a created session can be read back', async () => {
      const store = await create()
      const created = await store.create({
        subject: 'user-alice',
        email: 'alice@shuttle.test',
        roles: ['admin'],
      })
      expect(created.id).toBeString()
      expect(created.subject).toBe('user-alice')
      expect(created.roles).toEqual(['admin'])
      expect(created.expiresAt).toBeGreaterThan(created.createdAt)

      const read = await store.get(created.id)
      expect(read?.id).toBe(created.id)
      expect(read?.email).toBe('alice@shuttle.test')
      expect(read?.roles).toEqual(['admin'])
    })

    test('an unknown session is not found', async () => {
      const store = await create()
      expect(await store.get('does-not-exist')).toBeNull()
      expect(await store.get(undefined)).toBeNull()
    })

    test('a destroyed session is not found anymore', async () => {
      const store = await create()
      const created = await store.create({ subject: 'user-alice' })
      await store.destroy(created.id)
      expect(await store.get(created.id)).toBeNull()
    })

    test('destroying an unknown session is harmless', async () => {
      const store = await create()
      await store.destroy('does-not-exist')
      await store.destroy(undefined)
      expect(await store.get('does-not-exist')).toBeNull()
    })

    test('the sessions of two subjects are independent', async () => {
      const store = await create()
      const first = await store.create({ subject: 'user-alice' })
      const other = await store.create({ subject: 'user-bob' })

      await store.destroy(first.id)
      expect(await store.get(first.id)).toBeNull()
      // The session of the other subject is not affected.
      expect(await store.get(other.id)).not.toBeNull()
    })

    test('an expired session is not found', async () => {
      const store = await create()
      const created = await store.create({ subject: 'user-alice', ttlMs: 40 })
      expect(await store.get(created.id)).not.toBeNull()
      await Bun.sleep(60)
      expect(await store.get(created.id)).toBeNull()
    })

    test('reading a session extends its lifetime', async () => {
      // With a touch interval of zero every read refreshes the expiry, so
      // a caller that keeps working stays signed in.
      const store = await create({ touchIntervalMs: 0 })
      const created = await store.create({ subject: 'user-alice', ttlMs: 120 })
      const before = await store.get(created.id)
      await Bun.sleep(60)
      const after = await store.get(created.id)
      expect(after).not.toBeNull()
      expect(after?.expiresAt).toBeGreaterThan(before?.expiresAt ?? 0)
    })

    test('the store reports that it is reachable', async () => {
      const store = await create()
      expect(await store.ping()).toBe(true)
    })
  })
}

sessionContract('the in-process session store', (options) => new MemorySessionStore(options))

/**
 * A tiny in-memory stand in for a Redis server.
 *
 * It implements the handful of commands the session store uses, so the
 * layout of the keys and the bookkeeping around the sessions are covered by
 * the same contract as the other backends.
 */
class FakeRedis {
  #values = new Map<string, string>()
  #sets = new Map<string, Set<string>>()

  async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.#values.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      if (this.#values.delete(key)) removed += 1
      if (this.#sets.delete(key)) removed += 1
    }
    return removed
  }

  async ping(): Promise<'PONG'> {
    return 'PONG'
  }
}

sessionContract('the redis session store', (options) => {
  const fake = new FakeRedis()
  return new RedisSessionStore({
    url: 'redis://localhost:6379/0',
    keyPrefix: 'shuttle-test',
    client: fake as unknown as Bun.RedisClient,
    touchIntervalMs: options?.touchIntervalMs,
  })
})

if (REDIS_URL) {
  sessionContract('the redis session store', (options) => {
    const store = createSessionStore({
      url: REDIS_URL,
      keyPrefix: `shuttle-test-${Date.now()}`,
      ttlMs: 60_000,
      touchIntervalMs: options?.touchIntervalMs,
    })
    return store
  })
}

describe('the authentication service with a broken store', () => {
  /** A store that always fails, used to simulate an outage. */
  class BrokenStore extends MemorySessionStore {
    override async get(): Promise<null> {
      throw new Error('the store is not reachable')
    }
    override async create(): Promise<never> {
      throw new Error('the store is not reachable')
    }
    override async ping(): Promise<boolean> {
      return false
    }
  }

  const oidc = {
    createAuthorizationRequest: () => ({
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
    }),
    exchangeCode: async () => ({ id_token: 'token' }),
    verifyToken: async () => ({
      subject: 'user-alice',
      email: 'alice@shuttle.test',
      roles: ['admin'],
    }),
  } as unknown as AuthService['oidc']

  const service = (store: SessionStore): AuthService =>
    new AuthService({ oidc, sessions: store, secret: 'test-secret' })

  test('a caller without a readable session is not authenticated', async () => {
    const auth = service(new BrokenStore())
    const app = new Hono()
    app.get('/', async (c) => c.json({ principal: await auth.authenticate(c) }))
    const response = await app.request('/', {
      headers: { cookie: 'shuttle_session=whatever' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ principal: null })
  })

  test('a login reports the broken store', async () => {
    const auth = service(new BrokenStore())
    const app = new Hono()
    app.post('/login', async (c) => {
      await auth.completeLogin(c, { code: 'code', state: 'state' })
      return c.text('ok')
    })
    const response = await app.request('/login', {
      method: 'POST',
      headers: { cookie: `shuttle_oidc_state=${await stateCookie()}` },
    })
    expect(response.status).toBe(500)
  })

  test('a login reports the broken store as a session store error', async () => {    const auth = service(new BrokenStore())
    const app = new Hono()
    app.post('/login', async (c) => {
      try {
        await auth.completeLogin(c, { code: 'code', state: 'state' })
      } catch (error) {
        return c.json({ error: error instanceof SessionStoreError ? 'store' : 'other' })
      }
      return c.text('ok')
    })
    const response = await app.request('/login', {
      method: 'POST',
      headers: { cookie: `shuttle_oidc_state=${await stateCookie()}` },
    })
    expect(await response.json()).toEqual({ error: 'store' })
  })
})

describe('the login state cookie', () => {
  const oidc = {
    createAuthorizationRequest: () => ({
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
    }),
    exchangeCode: async () => ({ id_token: 'token' }),
    verifyToken: async () => ({ subject: 'user-alice', roles: [] }),
  } as unknown as AuthService['oidc']

  const app = (auth: AuthService): Hono => {
    const application = new Hono()
    application.post('/login', async (c) => {
      try {
        await auth.completeLogin(c, { code: 'code', state: 'state' })
      } catch (error) {
        return c.json({ error: error instanceof OidcError ? error.code : 'other' })
      }
      return c.text('ok')
    })
    return application
  }

  test('a state cookie that was tampered with is refused', async () => {
    const auth = new AuthService({
      oidc,
      sessions: new MemorySessionStore(),
      secret: 'test-secret',
    })
    const cookie = await stateCookie()
    // The signature of the cookie no longer belongs to the value.
    const tampered = cookie.slice(0, -4) + 'AAAA'
    const response = await app(auth).request('/login', {
      method: 'POST',
      headers: { cookie: `shuttle_oidc_state=${tampered}` },
    })
    expect(await response.json()).toEqual({ error: 'login_failed' })
  })

  test('a state cookie that was signed with another secret is refused', async () => {
    const auth = new AuthService({
      oidc,
      sessions: new MemorySessionStore(),
      secret: 'test-secret',
    })
    const other = await serializeSigned(
      'shuttle_oidc_state',
      JSON.stringify({ state: 'state', nonce: 'nonce', verifier: 'v', redirect: '/', exp: 1 }),
      'another-secret'
    )
    const value = other.slice(other.indexOf('=') + 1).split(';')[0]!
    const response = await app(auth).request('/login', {
      method: 'POST',
      headers: { cookie: `shuttle_oidc_state=${value}` },
    })
    expect(await response.json()).toEqual({ error: 'login_failed' })
  })
})

describe('the session store factory', () => {
  test('builds an in-process store from a memory url', async () => {
    const store = createSessionStore({ url: 'memory://local' })
    const created = await store.create({ subject: 'user-alice' })
    expect(await store.get(created.id)).not.toBeNull()
  })

  test('refuses an unsupported scheme', () => {
    expect(() => createSessionStore({ url: 'postgres://localhost/shuttle' })).toThrow(
      /unsupported session store/
    )
  })

  test('refuses a url that is not a url', () => {
    expect(() => createSessionStore({ url: 'not a url' })).toThrow(/not a valid url/)
  })
})
