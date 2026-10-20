/**
 * The principal of a caller and the choice of the credential.
 *
 * The mode of the route decides which credentials are accepted and the order
 * in which they are evaluated is fixed, so the credential that authenticates
 * a request never depends on the shape of the request.
 *
 * - `none`   no credential is accepted
 * - `session` only the session cookie
 * - `jwt`    only the bearer token
 * - `any`    the bearer token first, the session cookie second
 *
 * A route that accepts bearer tokens prefers the explicit `Authorization`
 * header over the cookie, and a credential that is present but invalid is
 * rejected instead of falling back to another one: a caller that asked for a
 * token and sent a wrong one is not a session caller.
 */

import type { AuthMode } from './policy'

/** The authenticated caller. */
export interface Principal {
  subject: string
  email?: string
  roles: string[]
  /**
   * The credential that authenticated the caller.
   *
   * The gateway needs it to know where the caller comes from: only a
   * session cookie is attached by a browser on its own.
   */
  source: 'session' | 'jwt'
}

/** Why a credential was refused. */
export type CredentialRefusal = 'not_a_bearer' | 'empty_bearer'

/**
 * The credential a request carries, as the mode of the route sees it.
 *
 * The decision is made without touching the network: the plan says which
 * credential has to be validated, and the validation is the next step.
 */
export type CredentialPlan =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'reject'; reason: CredentialRefusal }

/** The credentials a request carries. */
export interface CredentialInput {
  /** The value of the `Authorization` header, when there is one. */
  authorization?: string
  /** The value of the cookie of the session, when there is one. */
  sessionCookie?: string
}

/**
 * The bearer token of an `Authorization` header.
 *
 * A header that is not a bearer token is not a credential at all.
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer(?:\s+(.*))?$/i.exec(header.trim())
  if (!match) return null
  const token = (match[1] ?? '').trim()
  return token.length > 0 ? token : null
}

/**
 * Decides which credential of a request is used.
 *
 * The order is fixed:
 *
 * - the mode `session` ignores the `Authorization` header: the header is
 *   not a credential for that route;
 * - the mode `jwt` and the mode `any` refuse a request whose
 *   `Authorization` header is not a bearer token;
 * - the mode `any` takes the bearer token first and the session cookie
 *   second. A bearer token that is present but invalid is refused: the
 *   request is not let in with the session of the browser.
 */
export function selectCredential(mode: AuthMode, input: CredentialInput): CredentialPlan {
  if (mode === 'none') return { kind: 'none' }

  if (mode === 'session') {
    if (input.sessionCookie && input.sessionCookie.length > 0) {
      return { kind: 'session', sessionId: input.sessionCookie }
    }
    return { kind: 'none' }
  }

  if (input.authorization !== undefined) {
    const trimmed = input.authorization.trim()
    const bearer = /^Bearer(?:\s+(.*))?$/i.exec(trimmed)
    if (!bearer) {
      return { kind: 'reject', reason: 'not_a_bearer' }
    }
    const token = (bearer[1] ?? '').trim()
    if (token.length === 0) {
      return { kind: 'reject', reason: 'empty_bearer' }
    }
    return { kind: 'bearer', token }
  }

  if (mode === 'any' && input.sessionCookie && input.sessionCookie.length > 0) {
    return { kind: 'session', sessionId: input.sessionCookie }
  }

  return { kind: 'none' }
}
