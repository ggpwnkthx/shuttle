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
 * The signature is a **JWS** (RFC 7515) signed with `ES256` and the
 * private key of the deployment. The payload is **detached**: it is not
 * transmitted, because the upstream rebuilds it from the request and from
 * the identity headers it received. The upstream rebuilds the compact
 * serialization around its own payload and verifies it with the library,
 * so a signature that does not belong to the request is refused by the
 * verification itself and not by a comparison that could be written wrong.
 *
 * The symmetric format of the earlier releases (`v4`) is **removed**: the
 * key of that format was shared with the upstreams, so an upstream that
 * verified an identity could mint one as well. The trust boundary is the
 * key, and it is the private key of the deployment.
 */

import { CompactSign, base64url, compactVerify } from 'jose'
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

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
 * `v5` binds the whole request target: the method, the path, the query
 * string and the host, as the upstream receives them. It is a JWS with a
 * detached payload, signed with `ES256` and a private key the gateway
 * holds, so an upstream verifies it with the **public** key with a
 * standard library and cannot mint an identity of its own.
 *
 * The symmetric format of the earlier releases (`v4`) is removed in the
 * `1.0` release: its key was shared with the upstreams, so an upstream
 * that verified an identity could mint one as well.
 */
export const IDENTITY_SIGNATURE_VERSION = 'v5'

/** The header the signature is written to. */
export const IDENTITY_SIGNATURE_HEADER = 'x-shuttle-signature'

/**
 * The type of the protected header of the signature.
 *
 * It names what the signature is about, so an upstream that receives a
 * signature of another kind does not try to verify it.
 */
const IDENTITY_SIGNATURE_TYPE = 'shuttle-identity'

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
 * The algorithm of the signature of the identity.
 *
 * There is only one: the signature is asymmetric, so an upstream that
 * verifies an identity cannot mint one.
 */
export type IdentityAlgorithm = 'ES256'

/**
 * A key that signs the identity of a request.
 *
 * The key is the **private** key of the deployment (`ES256`): the gateway
 * holds it and the upstream holds the public one, so an upstream that can
 * verify an identity cannot mint one. The trust boundary is the key, and
 * not the network.
 */
export interface IdentitySigningKey {
  /** The version of the format of the signature. */
  version: string
  /** The algorithm of the signature. */
  algorithm: IdentityAlgorithm
  /** The key: the private key of the deployment. */
  key: KeyObject
}

/**
 * A key that verifies the identity of a request.
 *
 * It is the counterpart of the signing key: the public key of the private
 * one.
 */
export interface IdentityVerificationKey {
  /** The version of the format of the signature. */
  version: string
  /** The algorithm of the signature. */
  algorithm: IdentityAlgorithm
  /** The key: the public key of the deployment. */
  key: KeyObject
}

/**
 * The signing key of the deployment.
 *
 * The private key is a PEM of an elliptic curve key on the curve P-256,
 * and the signature is an `ES256` one. The upstream is given the **public**
 * key: it verifies the identity and it cannot mint one.
 *
 * The key belongs to the deployment: it is the same on every replica, or
 * the upstreams refuse the signatures of the others.
 */
export function asymmetricIdentityKey(privateKeyPem: string): IdentitySigningKey {
  let key: KeyObject
  try {
    key = createPrivateKey(privateKeyPem)
  } catch (error) {
    throw new Error(
      `the key of the identity signature is not a private key: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `the key of the identity signature is a ${key.asymmetricKeyType} key and not an elliptic curve one: the signature is an ES256 one`
    )
  }
  return {
    version: IDENTITY_SIGNATURE_VERSION,
    algorithm: 'ES256',
    key,
  }
}

/**
 * The key that verifies what a signing key signs.
 *
 * It is the public key of the private one.
 */
export function verificationKeyOf(signingKey: IdentitySigningKey): IdentityVerificationKey {
  return {
    version: signingKey.version,
    algorithm: signingKey.algorithm,
    key: createPublicKey(signingKey.key),
  }
}

/**
 * The public key of a signing key, as a PEM.
 *
 * It is what the upstreams are given: an upstream that holds the public
 * key verifies the identity of a request and it cannot mint one.
 */
export function publicKeyPem(signingKey: IdentitySigningKey): string {
  return createPublicKey(signingKey.key).export({ type: 'spki', format: 'pem' }).toString()
}

/**
 * A signing key that is generated for the process that uses it.
 *
 * It is the key of a deployment that has none: the identity is signed with
 * the format of the release, but the public key of it is unknown to the
 * upstreams, so an upstream cannot verify the identity of the request. The
 * key changes with every restart, and it is not shared by the replicas.
 *
 * A deployment that wants its upstreams to verify the identities sets
 * `SHUTTLE_IDENTITY_SIGNING_KEY`: the key belongs to the deployment, and it
 * is the same on every replica.
 */
export function ephemeralIdentityKey(): IdentitySigningKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    version: IDENTITY_SIGNATURE_VERSION,
    algorithm: 'ES256',
    key: privateKey,
  }
}

/**
 * Makes a value safe to write into a header.
 *
 * The control characters are removed: a header cannot carry them, and a
 * value that carries one would be refused by the runtime instead of being
 * forwarded. The length is bounded.
 *
 * The function is for the values that are **hints** — the address of the
 * caller and the workspace of the request. The subject of the caller is
 * the identity itself, and it is never rewritten: see `writtenIdentity`.
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
 * Reports whether a value may be written into a header as it is.
 *
 * A header carries no control character, and the length of a value of an
 * identity header is bounded.
 */
function isWritableIdentityValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTITY_VALUE_LENGTH) return false
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
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
 * The subject is required and it is written **as it is**: a subject that
 * cannot be written into a header — one that carries a control character,
 * one that is empty, one that is longer than the bound — makes the request
 * fail with `500 internal_error`. The upstream never receives an identity
 * it cannot trust.
 *
 * The subject is never rewritten. A sanitization that removes a character
 * of a subject turns two callers into one: the access service, which
 * decides with the subject it was given, and the upstream, which reads the
 * subject of the header, would then speak of two different callers. The
 * address of the caller and the workspace of the request are hints, and
 * they are sanitized; the subject is the identity, and it is refused
 * rather than rewritten.
 */
export function writtenIdentity(identity: CallerIdentity): WrittenIdentity {
  if (!isWritableIdentityValue(identity.subject)) {
    throw new IdentityNotWritableError()
  }
  return {
    subject: identity.subject,
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
 *
 * The version is part of the payload: it binds the format of the
 * signature, and an upstream that rebuilds the payload of a version it
 * does not know refuses the signature.
 */
export function canonicalIdentityPayload(
  identity: WrittenIdentity,
  request: SignedRequest,
  version: string = IDENTITY_SIGNATURE_VERSION
): string {
  return JSON.stringify({
    v: version,
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
 * The result is `<version>=<the detached JWS>`: the version is part of the
 * value, so the format can change later without breaking the verification.
 *
 * The payload is detached: it is not part of the value. An upstream
 * rebuilds it from the request and from the identity headers, rebuilds the
 * compact serialization around it and verifies the signature.
 */
export async function signIdentity(
  identity: WrittenIdentity,
  request: SignedRequest,
  signingKey: IdentitySigningKey
): Promise<string> {
  const payload = new TextEncoder().encode(
    canonicalIdentityPayload(identity, request, signingKey.version)
  )
  const jws = await new CompactSign(payload)
    .setProtectedHeader({ alg: signingKey.algorithm, typ: IDENTITY_SIGNATURE_TYPE })
    .sign(signingKey.key as Parameters<CompactSign['sign']>[0])
  const [protectedHeader, , signature] = jws.split('.')
  return `${signingKey.version}=${protectedHeader}..${signature}`
}

/**
 * Verifies a signature.
 *
 * It is the counterpart of `signIdentity` and it exists so that the format
 * can be tested. The reference implementation an upstream copies is in
 * `examples/upstream-identity/verify.ts`, and it is the one that describes
 * the contract of §7.4 of the specification.
 *
 * The payload of the upstream is the one it rebuilt from the request and
 * from the identity headers: a signature that does not belong to them is
 * refused by the verification of the signature itself.
 *
 * A signature of another version is refused: the version is part of the
 * payload, so the signature of another format does not verify.
 *
 * The verification is bound to the combination of the version, the
 * algorithm and the key: the protected header has to name the algorithm of
 * the key and the type of the signature, and the payload of the signature
 * has to be detached. There is no fallback from one algorithm to another.
 */
export async function verifyIdentity(
  identity: WrittenIdentity,
  request: SignedRequest,
  verificationKey: IdentityVerificationKey,
  signature: string | null | undefined
): Promise<boolean> {
  if (!signature) return false
  const prefix = `${verificationKey.version}=`
  if (!signature.startsWith(prefix)) return false
  const parts = signature.slice(prefix.length).split('.')
  if (parts.length !== 3) return false
  const [protectedHeader, payload, detachedSignature] = parts
  if (!protectedHeader || !detachedSignature) return false
  // The payload is detached: the upstream rebuilds it and puts it back.
  if (payload !== '') return false
  const header = protectedHeaderOf(protectedHeader)
  if (!header) return false
  if (header.alg !== verificationKey.algorithm) return false
  if (header.typ !== IDENTITY_SIGNATURE_TYPE) return false
  const signed = new TextEncoder().encode(
    canonicalIdentityPayload(identity, request, verificationKey.version)
  )
  const compact = `${protectedHeader}.${base64url.encode(signed)}.${detachedSignature}`
  try {
    await compactVerify(compact, verificationKey.key as Parameters<typeof compactVerify>[1], {
      algorithms: [verificationKey.algorithm],
    })
    return true
  } catch {
    return false
  }
}

/**
 * The protected header of a signature.
 *
 * It is the header of the JWS: the algorithm and the type of the
 * signature. A header that is not a json object is refused.
 */
function protectedHeaderOf(segment: string): { alg?: string; typ?: string } | undefined {
  let decoded: string
  try {
    decoded = new TextDecoder().decode(base64url.decode(segment))
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as { alg?: string; typ?: string }
}
