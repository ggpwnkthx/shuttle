import { LRUCache } from 'lru-cache'
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  type CreateSessionInput,
  type SessionRecord,
  type SessionStore,
} from './types'
import { isExpired, newSessionRecord, touchDue } from './record'

export interface MemorySessionStoreOptions {
  ttlMs?: number
  maxSessions?: number
  /** Minimum delay between two expiry refreshes of the same session. */
  touchIntervalMs?: number
}

/**
 * In-process session store.
 *
 * This is the default for development and for single node deployments. The
 * sessions only live as long as the process, so a fleet behind a load
 * balancer needs a shared store instead.
 *
 * The store is bounded: at most `maxSessions` sessions exist, the oldest one
 * is dropped when the bound is reached. The eviction order and the expiry are
 * handled by `lru-cache`.
 */
export class MemorySessionStore implements SessionStore {
  /** The sessions, the least recently used one first. */
  #sessions: LRUCache<string, SessionRecord>
  #touched = new Map<string, number>()
  #ttlMs: number
  #touchIntervalMs: number

  constructor(options: MemorySessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
    this.#touchIntervalMs = options.touchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS
    this.#sessions = new LRUCache<string, SessionRecord>({
      max: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      ttl: this.#ttlMs,
    })
  }

  get ttlMs(): number {
    return this.#ttlMs
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now()
    const ttl = input.ttlMs ?? this.#ttlMs
    const record = newSessionRecord(input, ttl, now)
    this.#sessions.set(record.id, record, { ttl })
    this.#touched.set(record.id, now)
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
    if (isExpired(record, now)) {
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
  }

  #remove(id: string): void {
    this.#sessions.delete(id)
    this.#touched.delete(id)
  }

  /**
   * Refreshes the expiry of a session, at most once per touch interval.
   */
  async #maybeTouch(record: SessionRecord, now: number): Promise<void> {
    if (!touchDue(this.#touched.get(record.id), now, this.#touchIntervalMs)) return
    record.expiresAt = now + this.#ttlMs
    this.#sessions.set(record.id, record, { ttl: this.#ttlMs })
    this.#touched.set(record.id, now)
  }
}
