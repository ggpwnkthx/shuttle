import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Cryptographically random URL-safe token.
 *
 * The token is a session identifier or a request identifier, never a
 * credential: the secrets of the protocol (the PKCE verifier, the signed
 * cookie) come from the libraries that own them.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Constant time comparison of two strings. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
