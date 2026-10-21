import { describe, expect, test } from 'bun:test'
import { MemorySessionStore } from './adapters'
import {
  cookieMaxAgeSeconds,
  isPastMaximumAge,
  newSessionRecord,
  remainingIdleMs,
  remainingLifetimeMs,
  serializeCookie,
  sessionCookie,
  touchDue,
  type SessionLifetime,
} from './index'

/** The lifetime of the tests. */
const lifetime: SessionLifetime = {
  ttlMs: 60_000,
  maxAgeMs: 120_000,
  touchIntervalMs: 10_000,
}

describe('the lifetime of a session', () => {
  test('a fresh session has an idle lifetime and a maximum age', () => {
    const record = newSessionRecord({ subject: 'user-1' }, lifetime, 1_000_000)
    expect(record.expiresAt).toBe(1_060_000)
    expect(record.absoluteExpiresAt).toBe(1_120_000)
    expect(record.id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  test('a maximum age of zero is unlimited', () => {
    const record = newSessionRecord({ subject: 'user-1' }, { ...lifetime, maxAgeMs: 0 }, 1_000_000)
    expect(record.absoluteExpiresAt).toBeUndefined()
    expect(isPastMaximumAge(record, 10_000_000_000)).toBe(false)
    // The idle lifetime is the only bound.
    expect(remainingIdleMs(record, 1_000_000)).toBe(60_000)
  })

  test('a session that is older than its maximum age is over', () => {
    const record = newSessionRecord({ subject: 'user-1' }, lifetime, 1_000_000)
    expect(isPastMaximumAge(record, 1_119_999)).toBe(false)
    expect(isPastMaximumAge(record, 1_120_000)).toBe(true)
  })

  test('the cookie never outlives the session it names', () => {
    const record = newSessionRecord({ subject: 'user-1' }, lifetime, 1_000_000)
    // The idle lifetime is the smaller one here.
    expect(remainingLifetimeMs(record, 1_000_000)).toBe(60_000)
    expect(cookieMaxAgeSeconds(record, 1_000_000)).toBe(60)
    // After a refresh the idle lifetime is longer, but the maximum age of
    // the session is the bound that is left.
    const refreshed = { ...record, expiresAt: 1_100_000 }
    expect(remainingLifetimeMs(refreshed, 1_090_000)).toBe(10_000)
    expect(cookieMaxAgeSeconds(refreshed, 1_090_000)).toBe(10)
  })

  test('the cookie of a session without a maximum age follows the idle lifetime', () => {
    const record = newSessionRecord({ subject: 'user-1' }, { ...lifetime, maxAgeMs: 0 }, 1_000_000)
    expect(cookieMaxAgeSeconds(record, 1_030_000)).toBe(30)
  })

  test('the expiry is refreshed at most once per interval', () => {
    expect(touchDue(undefined, 1_000_000, 10_000)).toBe(true)
    expect(touchDue(1_000_000, 1_005_000, 10_000)).toBe(false)
    expect(touchDue(1_000_000, 1_010_000, 10_000)).toBe(true)
  })
})

describe('the store of the sessions of the process', () => {
  test('the store reports its lifetime', () => {
    const store = new MemorySessionStore({ ttlMs: 1000, maxAgeMs: 2000, touchIntervalMs: 100 })
    expect(store.ttlMs).toBe(1000)
    expect(store.maxAgeMs).toBe(2000)
    expect(store.touchIntervalMs).toBe(100)
  })

  test('the store forgets every session when it is closed', async () => {
    const store = new MemorySessionStore({ ttlMs: 60_000, maxAgeMs: 0, touchIntervalMs: 1000 })
    const created = await store.create({ subject: 'user-1' })
    expect(store.size).toBe(1)
    await store.close()
    expect(store.size).toBe(0)
    expect(await store.get(created.id)).toBeNull()
  })

  test('the store reports the lifetime of the cookie of a session', async () => {
    const store = new MemorySessionStore({ ttlMs: 60_000, maxAgeMs: 0, touchIntervalMs: 1000 })
    const created = await store.create({ subject: 'user-1' })
    expect(store.cookieMaxAgeSeconds(created.id)).toBeGreaterThan(0)
    expect(store.cookieMaxAgeSeconds('unknown')).toBe(0)
  })

  test('the store answers the probe of the readiness', async () => {
    const store = new MemorySessionStore()
    expect(await store.ping()).toBe(true)
  })

  test('a session that was created can be read', async () => {
    const store = new MemorySessionStore(lifetime)
    const created = await store.create({ subject: 'user-1', roles: ['admin'] })
    const read = await store.get(created.id)
    expect(read?.subject).toBe('user-1')
    expect(read?.roles).toEqual(['admin'])
  })

  test('a session that does not exist is not a session', async () => {
    const store = new MemorySessionStore(lifetime)
    expect(await store.get('nope')).toBeNull()
    expect(await store.get(undefined)).toBeNull()
  })

  test('a session that was destroyed is gone', async () => {
    const store = new MemorySessionStore(lifetime)
    const created = await store.create({ subject: 'user-1' })
    await store.destroy(created.id)
    expect(await store.get(created.id)).toBeNull()
  })

  test('the store is bounded', async () => {
    const store = new MemorySessionStore({ ...lifetime, maxSessions: 10 })
    for (let index = 0; index < 100; index++) {
      await store.create({ subject: `user-${index}` })
    }
    expect(store.size).toBeLessThanOrEqual(10)
  })

  test('a session that is past its maximum age is refused and removed', async () => {
    const store = new MemorySessionStore({ ...lifetime, maxAgeMs: 50 })
    const created = await store.create({ subject: 'user-1' })
    await Bun.sleep(80)
    expect(await store.get(created.id)).toBeNull()
    expect(store.size).toBe(0)
  })

  test('a session that is past its idle lifetime is refused', async () => {
    const store = new MemorySessionStore({ ...lifetime, ttlMs: 50 })
    const created = await store.create({ subject: 'user-1' })
    await Bun.sleep(80)
    expect(await store.get(created.id)).toBeNull()
  })

  test('the logout of a session cannot be undone by a read', async () => {
    const store = new MemorySessionStore(lifetime)
    const created = await store.create({ subject: 'user-1' })
    // The logout and the read of a busy caller happen at the same time.
    await Promise.all([store.destroy(created.id), store.get(created.id)])
    expect(await store.get(created.id)).toBeNull()
  })

  test('the sessions of a subject are revoked at once', async () => {
    const store = new MemorySessionStore(lifetime)
    const first = await store.create({ subject: 'user-1' })
    const second = await store.create({ subject: 'user-1' })
    const other = await store.create({ subject: 'user-2' })

    expect(await store.destroyBySubject('user-1')).toBe(2)
    expect(await store.get(first.id)).toBeNull()
    expect(await store.get(second.id)).toBeNull()
    // The sessions of the other callers are untouched.
    expect(await store.get(other.id)).not.toBeNull()
  })

  test('a subject that has no session revokes nothing', async () => {
    const store = new MemorySessionStore(lifetime)
    expect(await store.destroyBySubject('user-that-never-logged-in')).toBe(0)
  })

  test('a session that was destroyed is not revoked twice', async () => {
    const store = new MemorySessionStore(lifetime)
    const created = await store.create({ subject: 'user-1' })
    await store.destroy(created.id)
    expect(await store.destroyBySubject('user-1')).toBe(0)
  })
})

describe('the cookie of a session', () => {
  test('it carries the attributes of the specification', () => {
    const cookie = sessionCookie('the-id', 3600, { secure: true })
    expect(cookie.name).toBe('shuttle_session')
    expect(cookie.attributes.httpOnly).toBe(true)
    expect(cookie.attributes.secure).toBe(true)
    expect(cookie.attributes.sameSite).toBe('Lax')
    expect(cookie.attributes.path).toBe('/')
  })

  test('it is rendered as a set-cookie header', () => {
    const rendered = serializeCookie(sessionCookie('the-id', 3600, { secure: true }))
    expect(rendered).toBe(
      'shuttle_session=the-id; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax'
    )
  })

  test('a cookie of a deployment without tls is not secure', () => {
    const rendered = serializeCookie(sessionCookie('the-id', 60, { secure: false }))
    expect(rendered).not.toContain('Secure')
  })
})
