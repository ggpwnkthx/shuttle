/**
 * The contract of the shared state, whatever the server it lives in.
 *
 * The same suite runs against the Redis server and against the Postgres
 * server: the two are interchangeable, and the suite is what proves it. A
 * deployment that measures them side by side (see `docs/capacity.md`) has
 * to be sure that they behave the same way, not only that they are fast.
 */

import { describe, expect, test } from 'bun:test'
import type { SessionStore } from '../../src/domains/authentication'
import type { RequestLimiter } from '../../src/domains/rate-limiting'
import type { DecisionCache } from '../../src/domains/workspace-access'
import type { AuditEntry, RouteTableStore } from '../../src/domains/configuration'

/** The options of the lifetime of the sessions of the suite. */
export interface SessionStoreOptions {
  ttlMs?: number
  maxAgeMs?: number
  touchIntervalMs?: number
}

/** The behaviour every store of the sessions has to show. */
export function describeSessionStore(
  label: string,
  factory: (options: SessionStoreOptions) => SessionStore
): void {
  describe(`the store of the sessions in ${label}`, () => {
    test('a session that was created is read again', async () => {
      const store = factory({ ttlMs: 60_000 })
      const created = await store.create({
        subject: 'user-1',
        email: 'u@example.test',
        roles: ['admin'],
      })
      expect(created.id).toBeString()

      const read = await store.get(created.id)
      expect(read?.subject).toBe('user-1')
      expect(read?.email).toBe('u@example.test')
      expect(read?.roles).toEqual(['admin'])
    })

    test('a session that does not exist is not created by a read', async () => {
      const store = factory({ ttlMs: 60_000 })
      expect(await store.get('does-not-exist')).toBeNull()
      expect(await store.get(undefined)).toBeNull()
    })

    test('a destroyed session is gone', async () => {
      const store = factory({ ttlMs: 60_000 })
      const created = await store.create({ subject: 'user-1' })
      await store.destroy(created.id)
      expect(await store.get(created.id)).toBeNull()
    })

    test('a logout is not undone by a read that happens at the same time', async () => {
      const store = factory({ ttlMs: 60_000 })
      for (let round = 0; round < 10; round++) {
        const created = await store.create({ subject: 'user-1' })
        // The logout and the read of a busy caller happen at the same time.
        await Promise.all([store.destroy(created.id), store.get(created.id)])
        // The session stays gone: the refresh of the expiry never
        // recreates a session that was deleted.
        expect(await store.get(created.id)).toBeNull()
      }
    })

    test('the refresh never reaches beyond the maximum age of the session', async () => {
      const store = factory({ ttlMs: 60_000, maxAgeMs: 300, touchIntervalMs: 0 })
      const created = await store.create({ subject: 'user-1' })
      expect(created.absoluteExpiresAt).toBeDefined()

      await Bun.sleep(150)
      const refreshed = await store.get(created.id)
      expect(refreshed).not.toBeNull()
      // The idle lifetime was 60 seconds, the maximum age is 300
      // milliseconds: the refresh is capped by the maximum age.
      expect(refreshed!.expiresAt).toBeLessThanOrEqual(created.absoluteExpiresAt!)

      await Bun.sleep(250)
      // The session is over: it is older than its maximum age, whatever the
      // activity of the caller was.
      expect(await store.get(created.id)).toBeNull()
    })

    test('the expiry is not refreshed before the interval is over', async () => {
      const store = factory({ ttlMs: 60_000, touchIntervalMs: 5_000 })
      const created = await store.create({ subject: 'user-1' })
      const first = await store.get(created.id)
      await Bun.sleep(50)
      const second = await store.get(created.id)
      expect(second!.expiresAt).toBe(first!.expiresAt)
    })

    test('a session that is over its idle lifetime is refused', async () => {
      const store = factory({ ttlMs: 300, touchIntervalMs: 0 })
      const created = await store.create({ subject: 'user-1' })
      expect(await store.get(created.id)).not.toBeNull()
      await Bun.sleep(400)
      expect(await store.get(created.id)).toBeNull()
    })

    test('the sessions of a subject are revoked at once', async () => {
      const store = factory({ ttlMs: 60_000 })
      const first = await store.create({ subject: 'user-7' })
      const second = await store.create({ subject: 'user-7' })
      const other = await store.create({ subject: 'user-8' })

      const removed = await store.destroyBySubject('user-7')
      expect(removed).toBe(2)
      expect(await store.get(first.id)).toBeNull()
      expect(await store.get(second.id)).toBeNull()
      // The sessions of the other callers are untouched.
      expect(await store.get(other.id)).not.toBeNull()
    })

    test('a subject that has no session revokes nothing', async () => {
      const store = factory({ ttlMs: 60_000 })
      expect(await store.destroyBySubject('user-that-never-logged-in')).toBe(0)
    })

    test('a subject that is revoked twice revokes nothing the second time', async () => {
      const store = factory({ ttlMs: 60_000 })
      const created = await store.create({ subject: 'user-9' })
      expect(await store.destroyBySubject('user-9')).toBe(1)
      expect(await store.destroyBySubject('user-9')).toBe(0)
      expect(await store.get(created.id)).toBeNull()
    })
  })
}

/** The behaviour every limiter of the shared state has to show. */
export function describeRateLimiter(
  label: string,
  factory: (options: { max: number; windowMs: number }) => RequestLimiter
): void {
  describe(`the limiter in ${label}`, () => {
    test('a caller is allowed up to the limit', async () => {
      const limiter = factory({ max: 3, windowMs: 60_000 })
      for (let index = 0; index < 3; index++) {
        const decision = await limiter.check('caller-1')
        expect(decision.allowed).toBe(true)
        expect(decision.remaining).toBe(2 - index)
      }
    })

    test('the request that is over the limit is refused', async () => {
      const limiter = factory({ max: 2, windowMs: 60_000 })
      expect((await limiter.check('caller-2')).allowed).toBe(true)
      expect((await limiter.check('caller-2')).allowed).toBe(true)

      const refused = await limiter.check('caller-2')
      expect(refused.allowed).toBe(false)
      expect(refused.remaining).toBe(0)
      // The caller has to wait for the oldest requests of the window to
      // leave it.
      expect(refused.retryAfterMs).toBeGreaterThan(0)
    })

    test('a refused request is not counted', async () => {
      const limiter = factory({ max: 2, windowMs: 60_000 })
      await limiter.check('caller-3')
      await limiter.check('caller-3')
      // A client that keeps hammering is refused, and its hammering does
      // not push the window further away.
      for (let index = 0; index < 5; index++) {
        expect((await limiter.check('caller-3')).allowed).toBe(false)
      }
      const still = await limiter.check('caller-3')
      expect(still.allowed).toBe(false)
    })

    test('the callers are counted apart', async () => {
      const limiter = factory({ max: 1, windowMs: 60_000 })
      expect((await limiter.check('caller-4')).allowed).toBe(true)
      expect((await limiter.check('caller-5')).allowed).toBe(true)
      expect((await limiter.check('caller-4')).allowed).toBe(false)
    })

    test('the window slides', async () => {
      const limiter = factory({ max: 2, windowMs: 500 })
      expect((await limiter.check('caller-6')).allowed).toBe(true)
      expect((await limiter.check('caller-6')).allowed).toBe(true)
      expect((await limiter.check('caller-6')).allowed).toBe(false)

      // The window moves: the requests that left it are not counted any
      // more.
      await Bun.sleep(700)
      expect((await limiter.check('caller-6')).allowed).toBe(true)
    })

    test('a limiter without a limit allows everything', async () => {
      const limiter = factory({ max: 0, windowMs: 60_000 })
      expect(limiter.disabled).toBe(true)
      for (let index = 0; index < 5; index++) {
        expect((await limiter.check('caller-7')).allowed).toBe(true)
      }
    })
  })
}

/** The behaviour every cache of the decisions has to show. */
export function describeDecisionCache(label: string, factory: () => DecisionCache): void {
  describe(`the cache of the decisions in ${label}`, () => {
    test('a decision that was cached is read again', async () => {
      const cache = factory()
      await cache.set(
        'key-1',
        { allow: true, kind: 'allowed', reason: '', decidedAt: 1234 },
        60_000
      )
      const read = await cache.get('key-1')
      expect(read?.allow).toBe(true)
      expect(read?.kind).toBe('allowed')
      expect(read?.decidedAt).toBe(1234)
    })

    test('a decision that was not cached is not served', async () => {
      const cache = factory()
      expect(await cache.get('key-2')).toBeNull()
    })

    test('the code of the reason survives the cache', async () => {
      // The code of the reason is what the metric counts. A decision that
      // comes from the cache has to be counted as exactly as the one that
      // was asked for, so the code has to survive the round trip.
      const cache = factory()
      await cache.set(
        'key-code',
        {
          allow: false,
          kind: 'denied',
          reason: 'the subject does not have the role',
          reasonCode: 'missing_role',
          decidedAt: 99,
        },
        60_000
      )
      const read = await cache.get('key-code')
      expect(read?.reasonCode).toBe('missing_role')
    })

    test('a code that is not known is not carried', async () => {
      const cache = factory()
      await cache.set(
        'key-unknown-code',
        {
          allow: false,
          kind: 'denied',
          reason: 'denied',
          reasonCode: 'something-else' as never,
          decidedAt: 99,
        },
        60_000
      )
      const read = await cache.get('key-unknown-code')
      expect(read?.reasonCode).toBeUndefined()
    })

    test('a refusal is cached as well', async () => {
      const cache = factory()
      await cache.set(
        'key-3',
        { allow: false, kind: 'denied', reason: 'missing_role', decidedAt: 7 },
        60_000
      )
      const read = await cache.get('key-3')
      expect(read?.allow).toBe(false)
      expect(read?.kind).toBe('denied')
      expect(read?.reason).toBe('missing_role')
    })

    test('a decision that is deleted is gone', async () => {
      const cache = factory()
      await cache.set('key-4', { allow: true, kind: 'allowed', reason: '', decidedAt: 1 }, 60_000)
      await cache.delete('key-4')
      expect(await cache.get('key-4')).toBeNull()
    })

    test('a decision that is over its lifetime is not served', async () => {
      const cache = factory()
      await cache.set('key-5', { allow: true, kind: 'allowed', reason: '', decidedAt: 1 }, 100)
      expect(await cache.get('key-5')).not.toBeNull()
      await Bun.sleep(200)
      expect(await cache.get('key-5')).toBeNull()
    })

    test('a decision without a lifetime is not cached', async () => {
      const cache = factory()
      await cache.set('key-6', { allow: true, kind: 'allowed', reason: '', decidedAt: 1 }, 0)
      expect(await cache.get('key-6')).toBeNull()
    })
  })
}

/**
 * The behaviour every store of the route table has to show.
 *
 * The route table of the shared state is a list of immutable revisions and
 * a pointer that names the active one (§3.4 of the specification). The
 * suite proves that the two servers hold the same thing with the same
 * contract: the revisions, the compare and swap, the history, the
 * heartbeats of the replicas and the trail of the writes.
 */
export function describeRouteTableStore(label: string, factory: () => RouteTableStore): void {
  describe(`the route table in ${label}`, () => {
    /** An entry of the audit trail of a write. */
    const audit = (action: string): AuditEntry => ({
      action,
      target: 'route-table',
      operator: 'the-operator',
      scope: 'config',
      address: '127.0.0.1',
      request: { action },
      at: Date.now(),
    })

    test('an empty store has no active revision', async () => {
      const store = factory()
      expect(await store.activePointer()).toBeNull()
    })

    test('a written revision becomes the active one', async () => {
      const store = factory()
      const outcome = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return

      const pointer = await store.activePointer()
      expect(pointer?.revision).toBe(outcome.revision)

      const revision = await store.readRevision(outcome.revision)
      expect(revision?.author).toBe('the-operator')
      expect(revision?.table).toEqual({ routes: [{ id: 'a', path: '/a' }] })
    })

    test('a revision is never changed', async () => {
      const store = factory()
      const first = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = await store.writeRevision({
        table: { routes: [{ id: 'b', path: '/b' }] },
        author: 'the-operator',
        expectedRevision: first.revision,
        audit: audit('config.write'),
      })
      expect(second.ok).toBe(true)

      // The first revision still holds the table it was written with.
      const revision = await store.readRevision(first.revision)
      expect(revision?.table).toEqual({ routes: [{ id: 'a', path: '/a' }] })
    })

    test('a write that lost the race writes nothing', async () => {
      const store = factory()
      const first = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return

      // The writer believes that the store is empty: it lost the race.
      const second = await store.writeRevision({
        table: { routes: [{ id: 'b', path: '/b' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.reason).toBe('conflict')
      expect(second.active).toBe(first.revision)

      // The pointer did not move and the table was not written.
      const pointer = await store.activePointer()
      expect(pointer?.revision).toBe(first.revision)
      expect(await store.readRevision(first.revision + 1)).toBeNull()
    })

    test('the history holds the revisions, the newest first', async () => {
      const store = factory()
      const first = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = await store.writeRevision({
        table: { routes: [{ id: 'b', path: '/b' }] },
        author: 'the-operator',
        expectedRevision: first.revision,
        audit: audit('config.write'),
      })
      expect(second.ok).toBe(true)

      const page = await store.listRevisions({ limit: 10, offset: 0 })
      expect(page.total).toBe(2)
      expect(page.entries[0]?.revision).toBe(second.ok ? second.revision : 0)
      expect(page.entries[1]?.revision).toBe(first.revision)

      const secondPage = await store.listRevisions({ limit: 1, offset: 1 })
      expect(secondPage.entries.length).toBe(1)
      expect(secondPage.entries[0]?.revision).toBe(first.revision)
    })

    test('the entry of the trail is written with the revision', async () => {
      const store = factory()
      const outcome = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(outcome.ok).toBe(true)

      const trail = await store.listAudit({ limit: 10, offset: 0 })
      expect(trail.total).toBeGreaterThan(0)
      const entry = trail.entries[0]
      expect(entry?.action).toBe('config.write')
      expect(entry?.operator).toBe('the-operator')
      expect(entry?.scope).toBe('config')
      expect(entry?.address).toBe('127.0.0.1')
    })

    test('a write that lost the race leaves no entry in the trail', async () => {
      const store = factory()
      const first = await store.writeRevision({
        table: { routes: [{ id: 'a', path: '/a' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      expect(first.ok).toBe(true)
      const before = await store.listAudit({ limit: 100, offset: 0 })

      await store.writeRevision({
        table: { routes: [{ id: 'b', path: '/b' }] },
        author: 'the-operator',
        expectedRevision: null,
        audit: audit('config.write'),
      })
      const after = await store.listAudit({ limit: 100, offset: 0 })
      // The change and its trace exist without each other: a write that
      // did not happen left no trace.
      expect(after.total).toBe(before.total)
    })

    test('the heartbeats of the replicas are listed', async () => {
      const store = factory()
      await store.writeHeartbeat(
        { replicaId: 'replica-1', revision: 7, lastError: null, at: Date.now() },
        60_000
      )
      const heartbeats = await store.listHeartbeats()
      const heartbeat = heartbeats.find((entry) => entry.replicaId === 'replica-1')
      expect(heartbeat?.revision).toBe(7)
      expect(heartbeat?.lastError).toBeNull()
    })

    test('a heartbeat that is over its lifetime disappears', async () => {
      const store = factory()
      await store.writeHeartbeat(
        {
          replicaId: 'replica-gone',
          revision: null,
          lastError: 'the store is down',
          at: Date.now(),
        },
        1
      )
      await Bun.sleep(30)
      const heartbeats = await store.listHeartbeats()
      expect(heartbeats.find((entry) => entry.replicaId === 'replica-gone')).toBeUndefined()
    })
  })
}
