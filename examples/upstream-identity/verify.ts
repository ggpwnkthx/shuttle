/**
 * The verification of the identity of a request, as an upstream writes it.
 *
 * This file is the reference implementation of the contract of §7.4 of the
 * specification. It is **standalone**: it does not import anything of the
 * gateway, so an upstream copies it, or reads it and writes its own.
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
 * The guide is in [docs/upstream-identity.md](../../docs/upstream-identity.md).
 */
import { compactVerify, type KeyInput } from 'jose'

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
   */
  publicKey: KeyInput
}

/** The outcome of the verification. */
export type VerifyResult =
  | { ok: true; identity: UpstreamIdentity; version: string }
  | { ok: false; reason: string }

/** The version of the format of the signature the upstream understands. */
export const SUPPORTED_VERSIONS = ['v5', 'v4'] as const

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
  if (!(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
    return { ok: false, reason: `the version "${version}" of the signature is not known` }
  }

  const parts = signature.slice(separator + 1).split('.')
  if (parts.length !== 3) return { ok: false, reason: 'the signature is malformed' }
  const [protectedHeader, payload, detachedSignature] = parts
  if (!protectedHeader || !detachedSignature) {
    return { ok: false, reason: 'the signature is malformed' }
  }
  if (payload !== '') {
    // The payload is detached: the upstream rebuilds it and puts it back.
    return { ok: false, reason: 'the payload of the signature is not detached' }
  }

  const identity = identityOf(headers)
  const rebuilt = canonicalPayload(identity, request, version)
  const compact = `${protectedHeader}.${base64url(rebuilt)}.${detachedSignature}`

  try {
    await compactVerify(compact, publicKey)
  } catch {
    return { ok: false, reason: 'the signature does not verify' }
  }
  return { ok: true, identity, version }
}

/** The base64url encoding of a string, without padding. */
function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}
