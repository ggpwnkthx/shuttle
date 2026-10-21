/**
 * The identity of the caller, as it is written into the headers.
 *
 * The gateway writes the identity of the caller into the headers of the
 * request it forwards. Those headers are only trustworthy when the request
 * went through the gateway, which means the upstream has to be unreachable
 * from anywhere else.
 *
 * The signature makes that assumption checkable: the gateway signs the
 * identity it wrote, and an upstream that wants to be sure can verify the
 * signature with the key it was configured with. A request that did not go
 * through the gateway cannot produce a valid signature.
 *
 * The signed payload is the identity itself plus the request it belongs to,
 * so a signature cannot be moved to another request or to another route.
 *
 * The signature is a **JWS** (RFC 7515) signed with `HS256` and a derived
 * key. The payload is **detached**: it is not transmitted, because the
 * upstream rebuilds it from the request and from the identity headers it
 * received. The upstream rebuilds the compact serialization around its own
 * payload and verifies it with the library, so a signature that does not
 * belong to the request is refused by the verification itself and not by a
 * comparison that could be written wrong.
 */

import { CompactSign, base64url, compactVerify } from 'jose'
import { createHmac } from 'node:crypto'

/** The identity of a caller, as the authentication domain knows it. */
export interface CallerIdentity {
  subject: string
  email?: string
  roles: string[]
  workspaceId?: string
}

/**
 * The identity as it is written into the headers of a request.
 *
 * The values are the ones the upstream receives, so an upstream that
 * reconstructs the claims from the headers it got can verify the signature
 * of the identity.
 */
export interface WrittenIdentity {
  subject: string
  email?: string
  roles: string[]
  workspaceId?: string
}

/**
 * The maximum length of a value of an identity header.
 *
 * A subject or an e-mail address that is longer than this is not a name
 * but an attempt to fill the header buffer of the upstream.
 */
export const MAX_IDENTITY_VALUE_LENGTH = 512

/**
 * The version of the signature format.
 *
 * `v4` binds the whole request target: the method, the path, the query
 * string and the host, as the upstream receives them. It is a JWS with a
 * detached payload, so an upstream verifies it with a standard library.
 */
export const IDENTITY_SIGNATURE_VERSION = 'v4'

/** The header the signature is written to. */
export const IDENTITY_SIGNATURE_HEADER = 'x-shuttle-signature'

/**
 * The type of the protected header of the signature.
 *
 * It names what the signature is about, so an upstream that receives a
 * signature of another kind does not try to verify it.
 */
const IDENTITY_SIGNATURE_TYPE = 'shuttle-identity'

/** The algorithm of the signature. */
const IDENTITY_SIGNATURE_ALGORITHM = 'HS256'

/** The request the signature belongs to. */
export interface SignedRequest {
  method: string
  /**
   * The path of the request, as the upstream received it.
   *
   * The path the gateway forwards is the path of the request with the base
   * path of the upstream in front of it, so this is the path the upstream
   * sees in its own request line.
   */
  path: string
  /**
   * The query string of the request, with its leading `?`.
   *
   * It is the query string the upstream received, so the empty string when
   * the request had none.
   */
  query: string
  /**
   * The host the caller used to reach the gateway.
   *
   * It is the value of the `x-forwarded-host` header the gateway writes, so
   * an upstream reads it from there.
   */
  host: string
}

/**
 * Derives the key of the identity signature from the secret of the gateway.
 *
 * The key is derived, so the secret that signs the login state is not used
 * for the signature itself and the two can not be confused. The upstream is
 * given the derived key, not the secret.
 */
export function deriveIdentityKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('shuttle-identity-signature-v1').digest()
}

/**
 * Makes a value safe to write into a header.
 *
 * The control characters are removed: a header cannot carry them, and a
 * value that carries one would be refused by the runtime instead of being
 * forwarded. The length is bounded.
 */
export function sanitizeIdentityValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    out += character
    if (out.length >= MAX_IDENTITY_VALUE_LENGTH) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Reports whether a role would make the list of the roles ambiguous.
 *
 * The roles are written as a list that is separated by commas, so a role
 * that contains a comma (or a character that is not allowed in a header)
 * would make the list ambiguous.
 */
export function isAmbiguousRole(role: string): boolean {
  if (role.length === 0) return true
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
 * The roles that are written into the `x-shuttle-roles` header.
 *
 * A role that would make the list ambiguous is dropped: the list is
 * separated by commas, so a role that contains a comma cannot be told apart
 * from two roles. The complete list of the roles is handed to the access
 * service unfiltered, and the signature covers exactly the roles of the
 * header, so an upstream knows the roles it was given.
 */
export function filterRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => !isAmbiguousRole(role))
}

/** The subject of a caller that cannot be written into a header. */
export class IdentityNotWritableError extends Error {
  override readonly cause: unknown

  constructor(message = 'the subject of the caller cannot be written into a header') {
    super(message)
    this.name = 'IdentityNotWritableError'
  }
}

/**
 * The identity that is written into the headers of a request.
 *
 * The subject is required: a caller whose subject is empty after the
 * sanitization cannot be written into a header at all. The request fails
 * with `500 internal_error` in that case: the upstream never receives an
 * identity it cannot trust.
 */
export function writtenIdentity(identity: CallerIdentity): WrittenIdentity {
  const subject = sanitizeIdentityValue(identity.subject)
  if (!subject) {
    throw new IdentityNotWritableError()
  }
  return {
    subject,
    email: sanitizeIdentityValue(identity.email),
    roles: filterRoles(identity.roles),
    workspaceId: sanitizeIdentityValue(identity.workspaceId),
  }
}

/**
 * The canonical form of the signed payload.
 *
 * The payload is a json object: the escaping of json keeps every value in
 * its own field, so a value that contains a newline, a comma or a quote
 * cannot be moved from one field into another. The names of the fields are
 * explicit, so an upstream that rebuilds the payload cannot confuse two
 * fields of it. The roles are sorted, their order is not part of the
 * meaning.
 */
export function canonicalIdentityPayload(
  identity: WrittenIdentity,
  request: SignedRequest
): string {
  return JSON.stringify({
    v: IDENTITY_SIGNATURE_VERSION,
    method: request.method.toUpperCase(),
    path: request.path,
    query: request.query,
    host: request.host.toLowerCase(),
    subject: identity.subject,
    workspaceId: identity.workspaceId ?? '',
    email: identity.email ?? '',
    roles: [...identity.roles].sort(),
  })
}

/**
 * Signs the identity of a request.
 *
 * The result is `v4=<the detached JWS>`: the version is part of the value,
 * so the format can change later without breaking the verification.
 *
 * The payload is detached: it is not part of the value. An upstream
 * rebuilds it from the request and from the identity headers, rebuilds the
 * compact serialization around it and verifies the signature.
 */
export async function signIdentity(
  identity: WrittenIdentity,
  request: SignedRequest,
  key: Buffer
): Promise<string> {
  const payload = new TextEncoder().encode(canonicalIdentityPayload(identity, request))
  const jws = await new CompactSign(payload)
    .setProtectedHeader({ alg: IDENTITY_SIGNATURE_ALGORITHM, typ: IDENTITY_SIGNATURE_TYPE })
    .sign(key)
  const [protectedHeader, , signature] = jws.split('.')
  return `${IDENTITY_SIGNATURE_VERSION}=${protectedHeader}..${signature}`
}

/**
 * Verifies a signature.
 *
 * It is the counterpart of `signIdentity` and it exists so that the format
 * can be tested, and so that an upstream has a reference implementation.
 *
 * The payload of the upstream is the one it rebuilt from the request and
 * from the identity headers: a signature that does not belong to them is
 * refused by the verification of the signature itself.
 */
export async function verifyIdentity(
  identity: WrittenIdentity,
  request: SignedRequest,
  key: Buffer,
  signature: string | null | undefined
): Promise<boolean> {
  if (!signature) return false
  const prefix = `${IDENTITY_SIGNATURE_VERSION}=`
  if (!signature.startsWith(prefix)) return false
  const parts = signature.slice(prefix.length).split('.')
  if (parts.length !== 3) return false
  const [protectedHeader, , detachedSignature] = parts
  if (!protectedHeader || !detachedSignature) return false
  const payload = new TextEncoder().encode(canonicalIdentityPayload(identity, request))
  const compact = `${protectedHeader}.${base64url.encode(payload)}.${detachedSignature}`
  try {
    await compactVerify(compact, key)
    return true
  } catch {
    return false
  }
}
