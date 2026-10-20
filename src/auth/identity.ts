/**
 * The signature of the identity headers.
 *
 * The gateway writes the identity of the caller into the headers of the
 * request it forwards (`x-shuttle-user`, `x-shuttle-roles`, ...). Those
 * headers are only trustworthy when the request went through the gateway,
 * which means the upstream has to be unreachable from anywhere else.
 *
 * The signature makes that assumption checkable: the gateway signs the
 * identity it wrote, and an upstream that wants to be sure can verify the
 * signature with the shared secret. A request that did not go through the
 * gateway cannot produce a valid signature.
 *
 * The signed payload is the identity itself plus the request it belongs to,
 * so a signature cannot be moved to another request or to another route.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface IdentityClaims {
  subject: string
  email?: string
  roles: string[]
  workspaceId?: string
}

export interface SignedRequest {
  method: string
  /** The path of the request, without the query string. */
  path: string
  /** The query string of the request, with its leading `?`. */
  query: string
  /** The host of the request. */
  host: string
}

/**
 * The version of the signature format.
 *
 * `v2` binds the whole request target: the method, the path, the query
 * string and the host. `v1` only bound the method and the path, so a
 * signature could be replayed onto another query string of the same path
 * (`?admin=true` on a path that was signed without it).
 */
export const IDENTITY_SIGNATURE_VERSION = 'v2'

/** The header the signature is written to. */
export const IDENTITY_SIGNATURE_HEADER = 'x-shuttle-signature'

/**
 * Derives the key of the identity signature from the secret of the gateway.
 *
 * The key is derived, so the secret that signs the login state is not used
 * for the signature itself and the two can not be confused.
 */
export function deriveIdentityKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('shuttle-identity-signature-v1').digest()
}

/**
 * Reports whether a role would make the list of the roles ambiguous.
 *
 * The roles are written as a list that is separated by commas, so a role
 * that contains a comma (or a character that is not allowed in a header)
 * would make the list ambiguous.
 */
export function isAmbiguousRole(role: string): boolean {
  for (const character of role) {
    if (character === ',') return true
    const code = character.codePointAt(0) ?? 0
    // The control characters and the delete character are not allowed in
    // the value of a header.
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The canonical form of the signed payload.
 *
 * The payload is a json array: the escaping of json keeps every value in
 * its own field, so a value that contains a newline, a comma or a quote
 * cannot be moved from one field into another. The roles are sorted, their
 * order is not part of the meaning.
 */
export function canonicalIdentityPayload(
  claims: IdentityClaims,
  request: SignedRequest
): string {
  return JSON.stringify([
    IDENTITY_SIGNATURE_VERSION,
    request.method.toUpperCase(),
    request.path,
    request.query,
    request.host.toLowerCase(),
    claims.subject,
    claims.workspaceId ?? '',
    claims.email ?? '',
    [...claims.roles].sort(),
  ])
}

/**
 * Signs the identity of a request.
 *
 * The result is `v2=<hex>`, the version is part of the value so the format
 * can change later without breaking the verification.
 */
export function signIdentity(
  claims: IdentityClaims,
  request: SignedRequest,
  key: Buffer
): string {
  const signature = createHmac('sha256', key)
    .update(canonicalIdentityPayload(claims, request))
    .digest('hex')
  return `${IDENTITY_SIGNATURE_VERSION}=${signature}`
}

/**
 * Verifies a signature. It is the counterpart of `signIdentity` and it
 * exists so that the format can be tested, and so that an upstream has a
 * reference implementation.
 */
export function verifyIdentity(
  claims: IdentityClaims,
  request: SignedRequest,
  key: Buffer,
  signature: string | null | undefined
): boolean {
  if (!signature) return false
  const expected = Buffer.from(signIdentity(claims, request, key))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
