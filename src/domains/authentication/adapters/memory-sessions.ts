/**
 * The store of the sessions that lives in the memory of the process.
 *
 * This is the default for development and for single node deployments. The
 * sessions only live as long as the process, so a fleet behind a load
 * balancer needs a shared store instead.
 *
 * The store is bounded: at most `maxSessions` sessions exist, the oldest one
 * is dropped when the bound is reached.
 */

import { LRUCache } from 'lru-cache'
import {
  cookieMaxAgeSeconds,
  isPastIdleLifetime,
  isPastMaximumAge,
  newSessionRecord,
  remainingIdleMs,
  touchDue,
  type CreateSessionInput,
  type SessionLifetime,
  type SessionRecord,
  type SessionStore,
} from '../session'

export interface MemorySessionStoreOptions extends Partial<SessionLifetime> {
  /** The number of sessions of the store. */
  maxSessions?: number
}

/** The default number of sessions of the store. */
export const DEFAULT_MAX_SESSIONS = 5_000

export class MemorySessionStore implements SessionStore {
  /** The sessions, the least recently used one first. */
  #sessions: LRUCache<string, SessionRecord>
  /** The moment every session was written the last time. */
  #touched = new Map<string, number>()
  /** The sessions of every subject, so they can be revoked at once. */
  #bySubject = new Map<string, Set<string>>()
  #lifetime: SessionLifetime
  #maxSessions: number

  constructor(options: MemorySessionStoreOptions = {}) {
    this.#lifetime = {
      ttlMs: options.ttlMs ?? 8 * 60 * 60_000,
      maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60_000,
      touchIntervalMs: options.touchIntervalMs ?? 60_000,
    }
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#sessions = new LRUCache<string, SessionRecord>({
      max: this.#maxSessions,
      // The expiry is handled by the store itself, the ttl of the cache is
      // a safety net for the sessions that were never read again.
      ttl: Math.max(this.#lifetime.ttlMs, this.#lifetime.maxAgeMs || this.#lifetime.ttlMs),
    })
  }

  get ttlMs(): number {
    return this.#lifetime.ttlMs
  }

  get maxAgeMs(): number {
    return this.#lifetime.maxAgeMs
  }

  get touchIntervalMs(): number {
    return this.#lifetime.touchIntervalMs
  }

  /** The number of sessions that are stored. */
  get size(): number {
    return this.#sessions.size
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now()
    const record = newSessionRecord(input, this.#lifetime, now)
    this.#sessions.set(record.id, record, { ttl: this.#ttlOf(record, now) })
    this.#touched.set(record.id, now)
    this.#index(record)
    return { ...record }
  }

  async get(id: string | undefined): Promise<SessionRecord | null> {
    if (!id) return null
    const record = this.#sessions.get(id)
    if (!record) {
      this.#touched.delete(id)
      return null
    }
    const now = Date.now()
    if (isPastMaximumAge(record, now) || isPastIdleLifetime(record, now)) {
      this.#remove(id)
      return null
    }
    // Reading a session refreshes its expiry, at most once per interval.
    await this.#maybeTouch(record, now)
    return { ...record }
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id) return
    this.#remove(id)
  }

  async destroyBySubject(subject: string): Promise<number> {
    const ids = this.#bySubject.get(subject)
    if (!ids || ids.size === 0) return 0
    let removed = 0
    for (const id of [...ids]) {
      if (this.#sessions.has(id)) removed += 1
      this.#remove(id)
    }
    this.#bySubject.delete(subject)
    return removed
  }

  async ping(): Promise<boolean> {
    return true
  }

  async close(): Promise<void> {
    this.clear()
  }

  /** Drops every session. */
  clear(): void {
    this.#sessions.clear()
    this.#touched.clear()
    this.#bySubject.clear()
  }

  /** The lifetime of a cookie that names a session of the store. */
  cookieMaxAgeSeconds(id: string, now: number = Date.now()): number {
    const record = this.#sessions.get(id)
    if (!record) return 0
    return cookieMaxAgeSeconds(record, now)
  }

  #remove(id: string): void {
    const record = this.#sessions.get(id)
    this.#sessions.delete(id)
    this.#touched.delete(id)
    if (!record) return
    // The subject of the session no longer has it.
    const ids = this.#bySubject.get(record.subject)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) this.#bySubject.delete(record.subject)
  }

  /** Remembers the session of a subject, so it can be revoked at once. */
  #index(record: SessionRecord): void {
    const ids = this.#bySubject.get(record.subject) ?? new Set<string>()
    ids.add(record.id)
    // The index follows the sessions: a session that was dropped by the
    // bound of the store is not remembered any more.
    if (ids.size > this.#maxSessions) {
      for (const id of [...ids]) {
        if (!this.#sessions.has(id)) ids.delete(id)
      }
    }
    this.#bySubject.set(record.subject, ids)
  }

  /**
   * Refreshes the expiry of a session, at most once per touch interval.
   *
   * The new expiry never reaches beyond the maximum age of the session.
   */
  async #maybeTouch(record: SessionRecord, now: number): Promise<void> {
    if (!touchDue(this.#touched.get(record.id), now, this.#lifetime.touchIntervalMs)) return
    // The new expiry never reaches beyond the maximum age of the session.
    const remaining = remainingIdleMs({ ...record, expiresAt: now + this.#lifetime.ttlMs }, now)
    record.expiresAt = now + remaining
    this.#sessions.set(record.id, record, { ttl: this.#ttlOf(record, now) })
    this.#touched.set(record.id, now)
  }

  /** The time the record of a session lives in the store. */
  #ttlOf(record: SessionRecord, now: number): number {
    return Math.max(1, remainingIdleMs(record, now))
  }
}
