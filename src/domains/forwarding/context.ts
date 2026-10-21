/**
 * The context of the forwarding.
 *
 * The context answers two questions: which address is the caller and which
 * protocol did the caller use. Both are read from the headers of the
 * request, but only when the peer that opened the connection is a proxy the
 * deployment trusts: a client can send any header it wants.
 */

import { ipInRanges } from './network'

/** The context of the forwarding of a request. */
export interface ForwardingContext {
  /** The address of the peer that opened the connection. */
  peerAddress: string
  /** True when the peer is a configured trusted proxy. */
  peerTrusted: boolean
  /** The address of the caller, as the deployment sees it. */
  clientIp: string
  /**
   * The chain of the addresses that is forwarded upstream.
   *
   * The chain starts with the address of the caller and ends with the
   * address of the peer of the gateway. The entries a client injected into
   * the chain it sent are not part of it.
   */
  chain: string[]
  /**
   * The protocol the caller used towards the gateway.
   *
   * It is the protocol the trusted proxy reports, when there is one, and the
   * configured one otherwise. Only `http` and `https` are accepted: a header
   * that names another protocol is ignored, so it can never influence the
   * origin of a request.
   */
  proto: 'http' | 'https'
  /**
   * The host the caller used, as the caller saw it.
   *
   * It is the host the trusted proxy reports in `x-forwarded-host`, when the
   * peer is a trusted proxy, and the host of the `Host` header otherwise.
   *
   * The host decides three things: the route that handles the request, the
   * origin the browser is compared with, and the value the signature of the
   * identity covers. A deployment behind an ingress that rewrites the `Host`
   * header therefore needs the ingress to report the public host.
   */
  host: string
}

export interface ForwardingContextOptions {
  /** The address of the peer that opened the connection. */
  peerAddress: string
  /** The headers of the request. */
  headers: Headers
  /** The ranges whose forwarding headers are trusted. */
  trustedProxies: readonly string[]
  /** The protocol the deployment is reached with, when nothing is reported. */
  externalProto: 'http' | 'https'
}

/**
 * Computes the forwarding context of a request.
 *
 * The chain of the forwarded addresses is read from the right: the entry
 * that was added last is the address of the hop that is closest to the
 * gateway, and the entries on its left were added earlier. A client can
 * only add entries on the left of the chain it sends, so the address of the
 * caller is the *right-most* entry that is not a trusted proxy.
 *
 * Reading the left-most entry instead would let a client that sends its own
 * `x-forwarded-for` header choose the address the gateway attributes to it,
 * and with it the key of the rate limiter.
 */
export function resolveForwardingContext(options: ForwardingContextOptions): ForwardingContext {
  const peerTrusted = ipInRanges(options.peerAddress, options.trustedProxies)
  const forwardedFor = options.headers.get('x-forwarded-for')
  const received = peerTrusted
    ? (forwardedFor ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : []
  const clientIndex = rightmostUntrustedIndex(received, options.trustedProxies)
  const clientIp = clientIndex === -1 ? options.peerAddress : received[clientIndex]!
  // The chain that is forwarded upstream starts at the caller. The entries
  // on the left of it are the ones a client injected, so they are dropped.
  const chain = [
    ...(clientIndex === -1 ? [] : received.slice(clientIndex)),
    options.peerAddress,
  ].filter(Boolean)

  const headerHost = options.headers.get('host') ?? ''
  const host = resolveEffectiveHost(headerHost, options.headers, peerTrusted)
  const forwardedProto = peerTrusted ? options.headers.get('x-forwarded-proto') : undefined
  const reported = forwardedProto?.trim().toLowerCase()
  const proto: 'http' | 'https' =
    reported === 'https' ? 'https' : reported === 'http' ? 'http' : options.externalProto

  return { peerAddress: options.peerAddress, peerTrusted, clientIp, chain, proto, host }
}

/**
 * The shape of a host a proxy may report.
 *
 * A host is a name, an address or an address between brackets, with an
 * optional port. It carries no whitespace, no control character and no path:
 * a value that does not look like a host is ignored rather than used.
 */
const HOST_PATTERN = /^[A-Za-z0-9._~:[\]-]+$/

/** The maximum length of a host. */
const MAX_HOST_LENGTH = 255

/**
 * Reports whether a value may be used as the host of a request.
 */
export function isPlausibleHost(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST_LENGTH) return false
  return HOST_PATTERN.test(value)
}

/**
 * The host the caller used, as the caller saw it.
 *
 * The `Host` header is the host the caller sent to the gateway. When the
 * peer is a trusted proxy, the proxy knows the host the caller really
 * called, and it reports it in `x-forwarded-host`.
 *
 * The value that is used is the **last** one of the list: a proxy that
 * appends to the header writes its own value last, so the value of the
 * proxy that is closest to the gateway is the one that is used. A proxy
 * that replaces the header writes a single value, which is the same thing.
 *
 * The header of a client that is not a trusted proxy is ignored: a client
 * chooses the host it calls and nothing else.
 */
export function resolveEffectiveHost(
  headerHost: string,
  headers: Headers,
  peerTrusted: boolean
): string {
  if (!peerTrusted) return headerHost
  const raw = headers.get('x-forwarded-host')
  if (!raw) return headerHost
  const candidates = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (candidates.length === 0) return headerHost
  const chosen = candidates[candidates.length - 1]!
  return isPlausibleHost(chosen) ? chosen : headerHost
}

/**
 * The index of the right-most address of a chain that is not a trusted
 * proxy, or -1 when every entry is a trusted proxy.
 */
function rightmostUntrustedIndex(entries: string[], trustedProxies: readonly string[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (!ipInRanges(entries[index]!, trustedProxies)) return index
  }
  return -1
}
