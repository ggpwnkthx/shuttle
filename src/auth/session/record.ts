/**
 * The parts of a session that every store shares.
 *
 * The record, its lifetime and the rule that decides when the expiry may be
 * refreshed are the same for every backend, so they live here instead of
 * being written twice. A store only owns the question "where do the bytes
 * live".
 */

import { randomToken } from '../crypto'
import type { CreateSessionInput, SessionRecord } from './types'

/** Creates the record of a fresh session. */
export function newSessionRecord(
  input: CreateSessionInput,
  ttlMs: number,
  now: number = Date.now()
): SessionRecord {
  return {
    id: randomToken(32),
    subject: input.subject,
    email: input.email,
    roles: input.roles ?? [],
    createdAt: now,
    expiresAt: now + ttlMs,
  }
}

/** Reports whether a session is past its lifetime. */
export function isExpired(record: SessionRecord, now: number = Date.now()): boolean {
  return record.expiresAt <= now
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
export function parseSessionRecord(raw: string): SessionRecord | null {
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
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
  }
}
