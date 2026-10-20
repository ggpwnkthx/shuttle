import { ipInRanges } from '../util/net'
import { IDENTITY_SIGNATURE_HEADER, filterRoles } from '../auth/identity'
import { isGatewaySetCookie, stripGatewayCookies } from '../auth/cookies'

/**
 * Inbound headers that are always dropped, so a client can never spoof an
 * identity. The list is part of the security invariant of the gateway and
 * therefore not configurable.
 */
const STRIPPED_REQUEST_HEADERS = [
  'x-shuttle-user',
  'x-shuttle-user-id',
  'x-shuttle-email',
  'x-shuttle-roles',
  'x-shuttle-workspace',
  'x-shuttle-workspace-id',
  'x-shuttle-internal',
  'x-shuttle-authenticated',
  'x-shuttle-signature',
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-groups',
  'x-remote-user',
  'x-remote-email',
]

/** The headers the gateway writes once the caller was authenticated. */
const IDENTITY_REQUEST_HEADERS = {
  user: 'x-shuttle-user',
  email: 'x-shuttle-email',
  roles: 'x-shuttle-roles',
  workspace: 'x-shuttle-workspace',
} as const

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/**
 * The response headers that are never forwarded to the caller.
 *
 * The hop-by-hop headers belong to the connection between the gateway and
 * the upstream, not to the message. The identity headers are the ones the
 * gateway writes on a *request*: an upstream that answered with them would
 * put an identity into the response, where a browser or a client library
 * could read it and believe it. The forwarding headers are the ones the
 * gateway writes itself.
 */
const STRIPPED_RESPONSE_HEADERS = [
  ...HOP_BY_HOP_HEADERS,
  ...Object.values(IDENTITY_REQUEST_HEADERS),
  IDENTITY_SIGNATURE_HEADER,
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'x-forwarded-port',
]

export interface ForwardingContext {
  /** Address of the peer that opened the connection. */
  peerAddress: string
  /** True when the peer is a configured trusted proxy. */
  peerTrusted: boolean
  /** Client address as seen by the gateway. */
  clientIp: string
  /**
   * The chain of addresses that is forwarded upstream.
   *
   * The chain starts with the address of the client and ends with the
   * address of the peer of the gateway. The entries a client injected into
   * the chain it sent are not part of it.
   */
  chain: string[]
  /**
   * Protocol used by the client towards the gateway.
   *
   * It is the protocol the trusted proxy reports, when there is one, and the
   * configured one otherwise. Only `http` and `https` are accepted: a header
   * that names another protocol is ignored, so it can never influence the
   * origin of a request.
   */
  proto: 'http' | 'https'
  /** Host requested by the client. */
  host: string
}

export interface IdentityHeaders {
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
const MAX_IDENTITY_VALUE_LENGTH = 512

/**
 * Makes a value safe to write into a header.
 *
 * The control characters are removed: a header cannot carry them, and a
 * value that carries one would be refused by the runtime instead of being
 * forwarded. The length is bounded.
 */
function safeHeaderValue(value: string | undefined): string | undefined {
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
 * The identity that is written into the headers of a request.
 *
 * The roles that would make the comma separated list of the header
 * ambiguous are dropped: a role that contains a comma cannot be told apart
 * from two roles. The complete list of the roles is handed to the access
 * service unfiltered, and the signature covers exactly the roles of the
 * header, so an upstream that reconstructs the claims from the headers it
 * received verifies the signature.
 */
export function writtenIdentity(identity: IdentityHeaders): WrittenIdentity {
  const subject = safeHeaderValue(identity.subject)
  if (!subject) {
    throw new Error('the subject of the caller cannot be written into a header')
  }
  const email = safeHeaderValue(identity.email)
  const workspaceId = safeHeaderValue(identity.workspaceId)
  return {
    subject,
    email,
    roles: filterRoles(identity.roles),
    workspaceId,
  }
}

/**
 * Rebuilds the header set that is forwarded upstream.
 *
 * - hop-by-hop headers are removed
 * - client supplied identity headers are removed (anti spoofing)
 * - the cookies of the gateway are removed (anti credential leak)
 * - forwarded headers are only honoured when the peer is a trusted proxy
 * - the authenticated identity is written using the configured header names
 */
export function buildUpstreamHeaders(options: {
  incoming: Headers
  forwarding: ForwardingContext
  identity?: WrittenIdentity
  /**
   * The signature of the identity, written next to the identity headers.
   *
   * An upstream that wants to be sure that the request went through the
   * gateway verifies it with the shared secret.
   */
  signature?: string
}): Headers {
  const { incoming, forwarding, identity, signature } = options
  const headers = new Headers()

  for (const [key, value] of incoming) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.includes(lower)) continue
    if (lower === 'host') continue
    if (lower === 'x-forwarded-for' || lower === 'x-forwarded-proto' || lower === 'x-forwarded-host') {
      continue
    }
    if (lower === 'x-forwarded-port') continue
    if (lower === 'x-real-ip') continue
    if (STRIPPED_REQUEST_HEADERS.includes(lower)) continue
    // The session cookie of the gateway is a credential of the caller: an
    // upstream that receives it can act as the caller against the gateway
    // itself, and against every other route of it. The cookies of the
    // application are kept, they belong to the application.
    if (lower === 'cookie') {
      const kept = stripGatewayCookies(value)
      if (kept) headers.set('cookie', kept)
      continue
    }
    headers.append(key, value)
  }

  // Forwarded information: only trusted when the immediate peer is a trusted proxy.
  headers.set('x-forwarded-for', forwarding.chain.join(', '))
  headers.set('x-forwarded-proto', forwarding.proto)
  headers.set('x-forwarded-host', forwarding.host)
  headers.set('x-real-ip', forwarding.clientIp)

  if (identity) {
    const names = IDENTITY_REQUEST_HEADERS
    headers.set(names.user, identity.subject)
    if (identity.email) headers.set(names.email, identity.email)
    // The roles are written as a list, separated by commas. A role that
    // contains a comma would make the list ambiguous, so it is not written
    // at all: the roles of the caller are handed to the access service
    // unfiltered, and the header is only a hint for the upstream. An
    // upstream that needs the exact roles verifies the signature and asks
    // the access service.
    headers.set(names.roles, identity.roles.join(','))
    if (identity.workspaceId) headers.set(names.workspace, identity.workspaceId)
    if (signature) headers.set(IDENTITY_SIGNATURE_HEADER, signature)
  }

  return headers
}

/**
 * Rebuilds the header set that is returned to the caller.
 *
 * The upstream is a different trust domain: its response headers are not
 * forwarded as they are.
 *
 * - the hop-by-hop headers are removed
 * - the identity headers of the gateway are removed, an upstream must not
 *   be able to put an identity into a response
 * - the forwarding headers of the gateway are removed, the gateway writes
 *   its own
 * - a `Set-Cookie` of the gateway is removed: the upstream must not be able
 *   to fix the session of the browser to an id of its choice, and to log
 *   the browser out
 */
export function buildClientHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  const withSetCookie = upstream as Headers & { getSetCookie?: () => string[] }
  const setCookies = typeof withSetCookie.getSetCookie === 'function' ? withSetCookie.getSetCookie() : []
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase()
    if (lower === 'set-cookie') continue
    if (STRIPPED_RESPONSE_HEADERS.includes(lower)) continue
    headers.append(key, value)
  }
  for (const cookie of setCookies) {
    if (isGatewaySetCookie(cookie)) continue
    headers.append('set-cookie', cookie)
  }
  return headers
}

/** Computes the forwarding context for a request. */
export function resolveForwarding(options: {
  peerAddress: string
  incoming: Headers
  trustedProxies: string[]
  tls: boolean
}): ForwardingContext {
  const peerTrusted = ipInRanges(options.peerAddress, options.trustedProxies)
  const forwardedFor = options.incoming.get('x-forwarded-for')
  // The chain of the forwarded addresses is read from the right: the entry
  // that was added last is the address of the hop that is closest to the
  // gateway, and the entries on its left were added earlier. A client can
  // only add entries on the left of the chain it sends, so the address of
  // the client is the *right-most* entry that is not a trusted proxy.
  //
  // Reading the left-most entry instead would let a client that sends its
  // own `x-forwarded-for` header choose the address the gateway attributes
  // to it, and with it the key of the rate limiter.
  const received = peerTrusted
    ? (forwardedFor ?? '').split(',').map((part) => part.trim()).filter(Boolean)
    : []
  const clientIndex = rightmostUntrustedIndex(received, options.trustedProxies)
  const clientIp =
    clientIndex === -1 ? options.peerAddress : received[clientIndex]!
  // The chain that is forwarded upstream starts at the client. The entries
  // on the left of it are the ones a client injected, so they are dropped.
  const chain = [
    ...(clientIndex === -1 ? [] : received.slice(clientIndex)),
    options.peerAddress,
  ].filter(Boolean)
  const host = options.incoming.get('host') ?? ''
  const forwardedProto = peerTrusted ? options.incoming.get('x-forwarded-proto') : undefined
  // Only the two protocols a browser can use are accepted. A trusted proxy
  // that reports something else is ignored, the configured protocol is used
  // instead: the origin of a request must never depend on an unvalidated
  // header.
  const proto: 'http' | 'https' =
    forwardedProto?.trim().toLowerCase() === 'https'
      ? 'https'
      : forwardedProto?.trim().toLowerCase() === 'http'
        ? 'http'
        : options.tls
          ? 'https'
          : 'http'
  return { peerAddress: options.peerAddress, peerTrusted, clientIp, chain, proto, host }
}

/**
 * The index of the right-most address of a chain that is not a trusted
 * proxy, or -1 when every entry is a trusted proxy.
 *
 * The chain is read from the right, because the entry that was added last
 * is the closest to the gateway. A client that sends its own
 * `x-forwarded-for` header can only add entries on the left, so the entries
 * on the right are the ones the trusted proxies added.
 */
function rightmostUntrustedIndex(entries: string[], trustedProxies: string[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!ipInRanges(entries[i]!, trustedProxies)) return i
  }
  return -1
}
