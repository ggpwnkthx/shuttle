import { ipInRanges } from '../util/net'
import { IDENTITY_SIGNATURE_HEADER } from '../auth/identity'

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

export interface ForwardingContext {
  /** Address of the peer that opened the connection. */
  peerAddress: string
  /** True when the peer is a configured trusted proxy. */
  peerTrusted: boolean
  /** Client address as seen by the gateway. */
  clientIp: string
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
  identity?: IdentityHeaders
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
    headers.append(key, value)
  }

  // Forwarded information: only trusted when the immediate peer is a trusted proxy.
  const clientChain = forwarding.peerTrusted
    ? (incoming.get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean)
    : []
  const chain = [...clientChain, forwarding.peerAddress].filter(Boolean).join(', ')
  headers.set('x-forwarded-for', chain)
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
    const roles = identity.roles.filter((role) => !isAmbiguousRole(role))
    headers.set(names.roles, roles.join(','))
    if (identity.workspaceId) headers.set(names.workspace, identity.workspaceId)
    if (signature) headers.set(IDENTITY_SIGNATURE_HEADER, signature)
  }

  return headers
}

/**
 * Reports whether a role would make the list of the roles ambiguous.
 *
 * The roles are written as a list that is separated by commas, so a role
 * that contains a comma (or a character that is not allowed in a header)
 * would make the list ambiguous.
 */
function isAmbiguousRole(role: string): boolean {
  for (const character of role) {
    if (character === ',') return true
    const code = character.codePointAt(0) ?? 0
    // The control characters and the delete character are not allowed in
    // the value of a header.
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
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
  // The left-most entry of the chain is the original client: every proxy
  // appends itself on the right, so the first one is the address the client
  // connected from.
  const clientIp =
    peerTrusted && forwardedFor
      ? (forwardedFor.split(',').map((part) => part.trim()).filter(Boolean).at(0) ?? options.peerAddress)
      : options.peerAddress
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
  return { peerAddress: options.peerAddress, peerTrusted, clientIp, proto, host }
}
