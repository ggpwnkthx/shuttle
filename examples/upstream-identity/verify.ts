/**
 * The verification of the identity of a request, as an upstream writes it.
 *
 * This file is the reference implementation of the contract of §7.4 of the
 * specification. It is **standalone**: it imports nothing of the gateway, so
 * an upstream copies it, or reads it and writes its own.
 *
 * The upstream:
 *
 * 1. reads the identity headers and the signature of the request;
 * 2. rebuilds the payload of the signature from the request and from the
 *    identity headers;
 * 3. rebuilds the compact serialization of the JWS around its own payload;
 * 4. verifies it with the **public** key of the deployment.
 *
 * The last step is one call of a standard library. An upstream does not
 * implement a signature of Shuttle, it verifies a JWS.
 *
 * The verifier is **strict about the combination** it accepts:
 *
 * | Version | Algorithm | The key |
 * | --- | --- | --- |
 * | `v5` | `ES256` | The public key of the deployment, a key of the curve P-256. |
 *
 * The version of the value decides the algorithm and the key, and the
 * protected header has to agree with it: a signature of one combination is
 * never verified with the key of another one, and there is no fallback from
 * one algorithm to another.
 *
 * The symmetric format of the earlier releases (`v4`) is **removed**: its
 * key was shared with the upstreams, so an upstream that verified an
 * identity could mint one as well. A `v4` signature is refused like any
 * other signature of an unknown version.
 *
 * The guide is in [docs/upstream-identity.md](../../docs/upstream-identity.md).
 */
import { base64url, compactVerify, type KeyInput } from 'jose'

/** The identity of a caller, as the upstream reads it from the headers. */
export interface UpstreamIdentity {
  /** The subject of the caller. */
  subject: string
  /** The e-mail address of the caller, when it is known. */
  email?: string
  /** The roles of the caller. */
  roles: string[]
  /** The workspace the caller uses, when the route has one. */
  workspaceId?: string
}

/** The request, as the upstream received it. */
export interface UpstreamRequest {
  /** The method of the request. */
  method: string
  /** The path of the request, as the upstream received it. */
  path: string
  /** The query string, with its leading `?`. The empty string when there is none. */
  query: string
  /** The host the caller used, as the gateway wrote it in `x-forwarded-host`. */
  host: string
}

/** The headers the upstream reads. */
export interface UpstreamHeaders {
  'x-shuttle-user': string
  'x-shuttle-email'?: string
  'x-shuttle-roles'?: string
  'x-shuttle-workspace'?: string
  'x-shuttle-signature'?: string
}

/** The options of the verification. */
export interface VerifyOptions {
  /** The request, as the upstream received it. */
  request: UpstreamRequest
  /** The headers of the request. */
  headers: UpstreamHeaders
  /**
   * The public key of the deployment.
   *
   * It is the key of the signature of the identity: the upstream verifies
   * with it and it cannot mint an identity with it. A PEM is imported with
   * `importSPKI(pem, 'ES256')` of the `jose` package, which returns a
   * `KeyObject` on the server and a `CryptoKey` in the browser.
   *
   * The key has to be a **public** key of the curve **P-256**: another key
   * is refused, so a deployment cannot verify an identity with a key that
   * another one holds.
   */
  publicKey: KeyInput
}

/** The outcome of the verification. */
export type VerifyResult =
  | { ok: true; identity: UpstreamIdentity; version: string }
  | { ok: false; reason: string }

/** The version of the format the gateway signs with its asymmetric key. */
export const SUPPORTED_VERSION = 'v5'

/** The algorithm of the format of {@link SUPPORTED_VERSION}. */
export const SUPPORTED_ALGORITHM = 'ES256'

/** The type of the protected header of the signature. */
export const SIGNATURE_TYPE = 'shuttle-identity'

/**
 * The payload of the signature.
 *
 * The fields are written in this order and the roles are sorted, so the
 * payload is one string that every replica and every upstream rebuilds
 * byte for byte.
 */
export function canonicalPayload(
  identity: UpstreamIdentity,
  request: UpstreamRequest,
  version: string
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

/** The identity of the caller, as the headers carry it. */
export function identityOf(headers: UpstreamHeaders): UpstreamIdentity {
  return {
    subject: headers['x-shuttle-user'],
    email: headers['x-shuttle-email'] || undefined,
    roles: (headers['x-shuttle-roles'] ?? '')
      .split(',')
      .filter((role) => role.length > 0),
    workspaceId: headers['x-shuttle-workspace'] || undefined,
  }
}

/**
 * Verifies the identity of a request.
 *
 * The signature is the value of the header `x-shuttle-signature`: the
 * version, a `=`, and the compact serialization of the JWS with an **empty**
 * payload. The upstream rebuilds the payload and puts it back in the
 * middle of the serialization.
 */
export async function verifyIdentity(options: VerifyOptions): Promise<VerifyResult> {
  const { request, headers, publicKey } = options
  const signature = headers['x-shuttle-signature']
  if (!signature) return { ok: false, reason: 'the request carries no signature' }

  const separator = signature.indexOf('=')
  if (separator === -1) return { ok: false, reason: 'the signature is malformed' }
  const version = signature.slice(0, separator)
  const serialized = signature.slice(separator + 1)

  // The version decides the algorithm and the key. There is no fallback:
  // a signature of one combination is never verified with the key of
  // another one, and there is no other version.
  if (version !== SUPPORTED_VERSION) {
    return { ok: false, reason: `the version "${version}" of the signature is not known` }
  }
  const algorithm = SUPPORTED_ALGORITHM
  const problem = problemOfPublicKey(publicKey)
  if (problem) return { ok: false, reason: problem }
  const key = publicKey

  const parts = serialized.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'the signature is malformed' }
  const [protectedHeader, payload, detachedSignature] = parts
  if (!protectedHeader || !detachedSignature) {
    return { ok: false, reason: 'the signature is malformed' }
  }
  if (payload !== '') {
    // The payload is detached: the upstream rebuilds it and puts it back.
    return { ok: false, reason: 'the payload of the signature is not detached' }
  }
  if (!isBase64url(protectedHeader) || !isBase64url(detachedSignature)) {
    return { ok: false, reason: 'the signature is malformed' }
  }

  const header = decodeProtectedHeader(protectedHeader)
  if (!header) return { ok: false, reason: 'the protected header of the signature is malformed' }
  if (header.alg !== algorithm) {
    return {
      ok: false,
      reason: `the signature of the version "${version}" has to be signed with "${algorithm}" and not with "${String(header.alg)}"`,
    }
  }
  if (header.typ !== SIGNATURE_TYPE) {
    return {
      ok: false,
      reason: `the type of the protected header has to be "${SIGNATURE_TYPE}" and not "${String(header.typ)}"`,
    }
  }

  const identity = identityOf(headers)
  const rebuilt = canonicalPayload(identity, request, version)
  const compact = `${protectedHeader}.${base64url.encode(rebuilt)}.${detachedSignature}`

  try {
    await compactVerify(compact, key, { algorithms: [algorithm] })
  } catch {
    return { ok: false, reason: 'the signature does not verify' }
  }
  return { ok: true, identity, version }
}

/** The protected header of a signature. */
interface ProtectedHeader {
  alg?: unknown
  typ?: unknown
}

/**
 * Reads the protected header of a signature.
 *
 * It is the header of the JWS: the algorithm and the type of the
 * signature. A header that is not a json object is refused.
 */
function decodeProtectedHeader(segment: string): ProtectedHeader | undefined {
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
  return parsed as ProtectedHeader
}

/** Reports whether a segment of the compact serialization is base64url. */
function isBase64url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * Reports whether the configured key is the public key of the deployment.
 *
 * The verifier accepts a public key of the curve P-256 and nothing else: a
 * private key, another curve or another kind of key is refused, so the
 * trust boundary of the upstream stays the key of the deployment.
 */
function problemOfPublicKey(key: KeyInput): string | undefined {
  if (isKeyObject(key)) {
    if (key.type !== 'public') {
      return 'the public key of the deployment is not a public key'
    }
    if (key.asymmetricKeyType !== 'ec') {
      return 'the public key of the deployment is not an elliptic curve key'
    }
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return 'the public key of the deployment is not a key of the curve P-256'
    }
    return undefined
  }
  if (isCryptoKey(key)) {
    if (key.algorithm.name !== 'ECDSA') {
      return 'the public key of the deployment is not an elliptic curve key'
    }
    if (key.algorithm.namedCurve !== 'P-256') {
      return 'the public key of the deployment is not a key of the curve P-256'
    }
    return undefined
  }
  if (isJwk(key)) {
    if (key.kty !== 'EC') {
      return 'the public key of the deployment is not an elliptic curve key'
    }
    if (key.crv !== 'P-256') {
      return 'the public key of the deployment is not a key of the curve P-256'
    }
    return undefined
  }
  return 'the public key of the deployment is not a key of the curve P-256'
}

/** A key of node, with the fields the check of the curve reads. */
interface NodeKeyObject {
  type: string
  asymmetricKeyType?: string
  asymmetricKeyDetails?: { namedCurve?: string }
}

/** Reports whether a key is a key of node. */
function isKeyObject(key: KeyInput): key is KeyInput & NodeKeyObject {
  return (
    typeof key === 'object' &&
    key !== null &&
    'type' in key &&
    typeof (key as { type: unknown }).type === 'string' &&
    'asymmetricKeyType' in key
  )
}

/** A key of the web crypto, with the fields the check of the curve reads. */
interface WebCryptoKey {
  algorithm: { name: string; namedCurve?: string }
}

/** Reports whether a key is a key of the web crypto. */
function isCryptoKey(key: KeyInput): key is KeyInput & WebCryptoKey {
  return (
    typeof key === 'object' &&
    key !== null &&
    'algorithm' in key &&
    typeof (key as { algorithm: unknown }).algorithm === 'object' &&
    (key as { algorithm: unknown }).algorithm !== null
  )
}

/** A key in the json form, with the fields the check of the curve reads. */
interface JsonWebKey {
  kty?: string
  crv?: string
}

/** Reports whether a key is a key in the json form. */
function isJwk(key: KeyInput): key is KeyInput & JsonWebKey {
  return typeof key === 'object' && key !== null && 'kty' in key
}
