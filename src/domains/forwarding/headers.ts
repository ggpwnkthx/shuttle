/**
 * The header policy of the gateway.
 *
 * The headers of a request that is forwarded and the headers of an answer
 * that is returned are both rebuilt: the gateway is a boundary between two
 * trust domains and neither side may write the headers of the other.
 *
 * The lists of this module are part of the security invariant of the
 * gateway and are therefore not configurable: an operator cannot weaken them
 * by accident.
 */

import { IDENTITY_SIGNATURE_HEADER, type WrittenIdentity } from './identity'
import type { ForwardingContext } from './context'

/**
 * The headers that belong to the connection and not to the message.
 *
 * They are removed in both directions: a proxy that forwards them breaks
 * the connection of the next hop.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
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
 * The identity headers of the gateway.
 *
 * They are written by the gateway and by nothing else: a client that sends
 * them is trying to be somebody else.
 */
export const IDENTITY_REQUEST_HEADERS: readonly string[] = [
  'x-shuttle-user',
  'x-shuttle-user-id',
  'x-shuttle-email',
  'x-shuttle-roles',
  'x-shuttle-workspace',
  'x-shuttle-workspace-id',
  'x-shuttle-internal',
  'x-shuttle-authenticated',
  IDENTITY_SIGNATURE_HEADER,
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-groups',
  'x-remote-user',
  'x-remote-email',
]

/** The names of the headers the gateway writes for the identity. */
export const IDENTITY_HEADER_NAMES = {
  user: 'x-shuttle-user',
  email: 'x-shuttle-email',
  roles: 'x-shuttle-roles',
  workspace: 'x-shuttle-workspace',
} as const

/**
 * The headers that are always removed from a request.
 *
 * The `x-forwarded-*` headers are removed as a family: the gateway writes
 * its own chain, and a client that sends one of them must not be able to
 * choose the name of the header the upstream reads.
 */
function isStrippedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (HOP_BY_HOP_HEADERS.includes(lower)) return true
  if (lower === 'host') return true
  if (lower === 'x-real-ip') return true
  // The standard `Forwarded` header carries the claim of a client about the
  // request it made. It competes with the chain the gateway writes, and an
  // upstream that trusts it would believe a client.
  if (lower === 'forwarded') return true
  if (lower.startsWith('x-forwarded-')) return true
  return IDENTITY_REQUEST_HEADERS.includes(lower)
}

/**
 * The headers that are always removed from an answer.
 *
 * The identity headers are the ones the gateway writes on a *request*: an
 * upstream that answered with them would put an identity into the response,
 * where a browser or a client library could read it and believe it.
 */
function isStrippedResponseHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (HOP_BY_HOP_HEADERS.includes(lower)) return true
  if (lower === 'x-real-ip') return true
  if (lower === 'forwarded') return true
  if (lower.startsWith('x-forwarded-')) return true
  return IDENTITY_REQUEST_HEADERS.includes(lower)
}

/**
 * The headers that the `Connection` header nominates.
 *
 * A hop-by-hop header may name the headers that belong to the same
 * connection: those headers are removed as well, whatever they are.
 */
export function connectionNominatedHeaders(headers: Headers): string[] {
  const nominated: string[] = []
  const connection = headers.get('connection')
  if (!connection) return nominated
  for (const token of connection.split(',')) {
    const name = token.trim().toLowerCase()
    if (name.length > 0) nominated.push(name)
  }
  return nominated
}

/**
 * The name of a cookie of a `Cookie` header.
 *
 * A `Cookie` header is a list of `name=value` pairs that are separated by
 * a semicolon. The name is the part in front of the first `=`.
 */
export function cookieNameOf(pair: string): string {
  const index = pair.indexOf('=')
  return (index === -1 ? pair : pair.slice(0, index)).trim()
}

/**
 * Removes the cookies of the gateway from a `Cookie` header.
 *
 * The cookies of the upstream application are kept: they belong to the
 * application, not to the gateway. The cookies of the gateway are removed,
 * because a session id is a credential of the caller and an upstream that
 * holds it can act as the caller.
 *
 * The names are compared case sensitively: a cookie name is case sensitive,
 * and `Shuttle_Session` is a cookie of another name.
 */
export function stripGatewayCookies(
  cookieHeader: string | null | undefined,
  gatewayCookies: readonly string[]
): string {
  if (!cookieHeader) return ''
  const kept = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !gatewayCookies.includes(cookieNameOf(part)))
  return kept.join('; ')
}

/**
 * Reports whether a `Set-Cookie` value writes a cookie of the gateway.
 *
 * An upstream that is able to write `shuttle_session` would be able to fix
 * the session of the browser to an id of its choice, and to log the browser
 * out. The gateway owns the name, so the upstream must not write it.
 */
export function isGatewaySetCookie(
  setCookieValue: string,
  gatewayCookies: readonly string[]
): boolean {
  const name = setCookieValue.split(';')[0] ?? ''
  return gatewayCookies.includes(cookieNameOf(name))
}

export interface UpstreamHeadersOptions {
  /** The headers the caller sent. */
  incoming: Headers
  /** The context of the forwarding. */
  forwarding: ForwardingContext
  /** The identity of the caller, when it was authenticated. */
  identity?: WrittenIdentity
  /**
   * The signature of the identity, written next to the identity headers.
   *
   * An upstream that wants to be sure that the request went through the
   * gateway verifies it with the key it was configured with.
   */
  signature?: string
  /** The names of the cookies the gateway owns. */
  gatewayCookies: readonly string[]
}

/**
 * Rebuilds the header set that is forwarded upstream.
 *
 * - the hop-by-hop headers and the headers they nominate are removed
 * - the client supplied identity headers are removed (anti spoofing)
 * - the cookies of the gateway are removed (anti credential leak)
 * - the forwarding headers are only honoured when the peer is a trusted
 *   proxy, and the gateway writes its own chain
 * - the authenticated identity is written using the configured header names
 */
export function buildUpstreamHeaders(options: UpstreamHeadersOptions): Headers {
  const { incoming, forwarding, identity, signature, gatewayCookies } = options
  const headers = new Headers()
  const nominated = connectionNominatedHeaders(incoming)

  for (const [key, value] of incoming) {
    const lower = key.toLowerCase()
    if (isStrippedRequestHeader(lower)) continue
    if (nominated.includes(lower)) continue
    if (lower === 'cookie') {
      const kept = stripGatewayCookies(value, gatewayCookies)
      if (kept) headers.set('cookie', kept)
      continue
    }
    headers.append(key, value)
  }

  // The forwarding information: the chain starts at the caller and ends at
  // the peer of the gateway.
  headers.set('x-forwarded-for', forwarding.chain.join(', '))
  headers.set('x-forwarded-proto', forwarding.proto)
  headers.set('x-forwarded-host', forwarding.host)
  headers.set('x-real-ip', forwarding.clientIp)

  if (identity) {
    headers.set(IDENTITY_HEADER_NAMES.user, identity.subject)
    if (identity.email) headers.set(IDENTITY_HEADER_NAMES.email, identity.email)
    // The roles are written as a list, separated by commas. A role that
    // contains a comma would make the list ambiguous, so it is not written
    // at all: the roles of the caller are handed to the access service
    // unfiltered, and the header is only a hint for the upstream.
    headers.set(IDENTITY_HEADER_NAMES.roles, identity.roles.join(','))
    if (identity.workspaceId) headers.set(IDENTITY_HEADER_NAMES.workspace, identity.workspaceId)
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
 *   to fix the session of the browser to an id of its choice, and to log the
 *   browser out
 */
export function buildClientHeaders(upstream: Headers, gatewayCookies: readonly string[]): Headers {
  const headers = new Headers()
  const withSetCookie = upstream as Headers & { getSetCookie?: () => string[] }
  const setCookies =
    typeof withSetCookie.getSetCookie === 'function' ? withSetCookie.getSetCookie() : []
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase()
    if (lower === 'set-cookie') continue
    if (isStrippedResponseHeader(lower)) continue
    headers.append(key, value)
  }
  for (const cookie of setCookies) {
    if (isGatewaySetCookie(cookie, gatewayCookies)) continue
    headers.append('set-cookie', cookie)
  }
  return headers
}
