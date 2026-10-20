/**
 * The session store is a port: the application only ever talks to this
 * interface, the concrete implementation decides where the sessions live.
 *
 * The contract is deliberately small so that it can be satisfied by any
 * key/value backend — a managed cache, a database or a local map — and not
 * only by one specific product. The infrastructure side only has to provide a
 * connection URL.
 */

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000
export const DEFAULT_MAX_SESSIONS = 5_000
export const DEFAULT_SESSION_TOUCH_INTERVAL_MS = 60_000

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

export interface SessionRecord {
  id: string
  subject: string
  email?: string
  roles: string[]
  createdAt: number
  expiresAt: number
}

export interface CreateSessionInput {
  subject: string
  email?: string
  roles?: string[]
  ttlMs?: number
}

export interface SessionStore {
  /** Lifetime of a freshly created session, in milliseconds. */
  readonly ttlMs: number
  create(input: CreateSessionInput): Promise<SessionRecord>
  /**
   * Reads a session.
   *
   * Reading a session refreshes its expiry, at most once per
   * `touchIntervalMs`. A caller that keeps working therefore stays signed
   * in without a separate refresh call.
   */
  get(id: string | undefined): Promise<SessionRecord | null>
  destroy(id: string | undefined): Promise<void>
  /** Reports whether the store can be reached. */
  ping(): Promise<boolean>
  close(): Promise<void>
}
