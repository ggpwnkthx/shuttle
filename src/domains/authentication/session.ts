/**
 * The sessions of the callers.
 *
 * A session is a server side record: the browser only holds an opaque id,
 * so the gateway can revoke a session, can expire it and can read the roles
 * of the caller again.
 *
 * A session has two independent bounds:
 *
 * - the **idle lifetime**: how long a session survives without being used.
 *   It is refreshed on a read, at most once per touch interval, so a busy
 *   caller is not written to the store on every request.
 * - the **maximum age**: how long a session may be used at all, counted
 *   from its creation, whatever the activity of the caller. A value of zero
 *   disables the cap: the maximum age is then unlimited and it is never read
 *   as "the session is over now".
 *
 * The idle lifetime alone does not bound the lifetime of a session: a caller
 * that keeps working could hold a session for ever. The maximum age does.
 */

import { randomBytes } from 'node:crypto'

/**
 * Raised when the session store cannot be reached.
 *
 * The gateway fails closed: a caller without a readable session is not
 * authenticated, it is never let in because the store had a hiccup.
 */
export class SessionStoreError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'SessionStoreError'
    this.cause = cause
  }
}

/** A session of a caller. */
export interface SessionRecord {
  /** The opaque id of the session; it is the value of the cookie. */
  id: string
  subject: string
  email?: string
  roles: string[]
  /** The moment the session was created. */
  createdAt: number
  /** The moment the idle lifetime of the session is over. */
  expiresAt: number
  /**
   * The moment the maximum age of the session is over.
   *
   * It is absent when the deployment has no maximum age.
   */
  absoluteExpiresAt?: number
}

/** What a caller needs to start a session. */
export interface CreateSessionInput {
  subject: string
  email?: string
  roles?: string[]
}

/** The settings of the lifetime of the sessions. */
export interface SessionLifetime {
  /** The idle lifetime of a session, in milliseconds. */
  ttlMs: number
  /** The maximum age of a session, in milliseconds. 0 means unlimited. */
  maxAgeMs: number
  /** The minimum delay between two refreshes of the expiry of a session. */
  touchIntervalMs: number
}

/**
 * The store of the sessions.
 *
 * The contract is deliberately small so that it can be satisfied by any
 * key/value backend and not only by one specific product. The infrastructure
 * side only has to provide a connection url.
 */
export interface SessionStore {
  /** The idle lifetime of a freshly created session, in milliseconds. */
  readonly ttlMs: number
  /** The maximum age of a session, in milliseconds. 0 means unlimited. */
  readonly maxAgeMs: number
  /** The minimum delay between two refreshes of the expiry of a session. */
  readonly touchIntervalMs: number
  create(input: CreateSessionInput): Promise<SessionRecord>
  /**
   * Reads a session.
   *
   * Reading a session refreshes its expiry, at most once per
   * `touchIntervalMs`. A session that is older than its maximum age is
   * refused and removed from the store.
   */
  get(id: string | undefined): Promise<SessionRecord | null>
  destroy(id: string | undefined): Promise<void>
  /**
   * Removes every session of a subject.
   *
   * The sessions of a caller are revoked one by one, or all at once: an
   * account that was compromised is ended without logging every other
   * caller out.
   *
   * It returns the number of sessions that were removed. A subject that
   * has no session removes nothing.
   */
  destroyBySubject(subject: string): Promise<number>
  /** Reports whether the store can be reached. */
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * An opaque, random id of a session.
 *
 * The id is a credential: whoever holds it is the caller. It is therefore
 * random and long enough that it cannot be guessed.
 */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url')
}

/** Creates the record of a fresh session. */
export function newSessionRecord(
  input: CreateSessionInput,
  lifetime: SessionLifetime,
  now: number = Date.now()
): SessionRecord {
  const record: SessionRecord = {
    id: newSessionId(),
    subject: input.subject,
    email: input.email,
    roles: input.roles ?? [],
    createdAt: now,
    expiresAt: now + lifetime.ttlMs,
  }
  if (lifetime.maxAgeMs > 0) {
    record.absoluteExpiresAt = now + lifetime.maxAgeMs
  }
  return record
}

/** Reports whether a session is past its idle lifetime. */
export function isPastIdleLifetime(record: SessionRecord, now: number = Date.now()): boolean {
  return record.expiresAt <= now
}

/**
 * Reports whether a session is past its maximum age.
 *
 * A session that is past its maximum age is refused whatever the activity of
 * the caller was: the caller has to log in again.
 */
export function isPastMaximumAge(record: SessionRecord, now: number = Date.now()): boolean {
  if (record.absoluteExpiresAt === undefined) return false
  return record.absoluteExpiresAt <= now
}

/**
 * The idle lifetime that is left, in milliseconds.
 *
 * It is never negative and it is never longer than the maximum age that is
 * left: a session cannot live longer than its cap.
 */
export function remainingIdleMs(record: SessionRecord, now: number = Date.now()): number {
  const idle = Math.max(0, record.expiresAt - now)
  if (record.absoluteExpiresAt === undefined) return idle
  return Math.min(idle, Math.max(0, record.absoluteExpiresAt - now))
}

/**
 * The lifetime that is left, in milliseconds.
 *
 * It is the smallest of the idle lifetime and of the maximum age: the
 * cookie of the browser never outlives the session it names.
 */
export function remainingLifetimeMs(record: SessionRecord, now: number = Date.now()): number {
  return remainingIdleMs(record, now)
}

/**
 * The lifetime of the cookie of the browser, in seconds.
 *
 * The cookie follows the session: the browser learns about the new lifetime
 * even when the request was refused. The value is a whole number of
 * seconds, because that is what a cookie carries.
 */
export function cookieMaxAgeSeconds(record: SessionRecord, now: number = Date.now()): number {
  return Math.max(0, Math.floor(remainingLifetimeMs(record, now) / 1000))
}

/**
 * Reports whether the expiry of a session may be refreshed.
 *
 * The interval keeps a busy caller from writing to the store on every single
 * request: the expiry is refreshed at most once per `touchIntervalMs`.
 */
export function touchDue(
  lastTouchAt: number | undefined,
  now: number,
  touchIntervalMs: number
): boolean {
  if (lastTouchAt === undefined) return true
  return now - lastTouchAt >= touchIntervalMs
}

/** Serializes a session record for a store that keeps bytes. */
export function serializeSessionRecord(record: SessionRecord): string {
  return JSON.stringify(record)
}

/**
 * Parses a session record.
 *
 * A record that cannot be read is rejected: a broken record never
 * authenticates a caller.
 */
export function parseSessionRecord(raw: string, now: number = Date.now()): SessionRecord | null {
  let parsed: Partial<SessionRecord>
  try {
    parsed = JSON.parse(raw) as Partial<SessionRecord>
  } catch {
    return null
  }
  if (typeof parsed.id !== 'string' || typeof parsed.subject !== 'string') return null
  return {
    id: parsed.id,
    subject: parsed.subject,
    email: parsed.email,
    roles: Array.isArray(parsed.roles) ? parsed.roles : [],
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    absoluteExpiresAt:
      typeof parsed.absoluteExpiresAt === 'number' ? parsed.absoluteExpiresAt : undefined,
  }
}
