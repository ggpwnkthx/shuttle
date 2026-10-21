/**
 * The forwarding domain.
 *
 * The domain owns the trust boundary between the gateway and the upstreams:
 * the evaluation of the trusted proxies, the policy of the origins, the
 * filtering of the headers and of the cookies, the construction of the
 * target and the signature of the identity.
 *
 * The http path and the websocket path use the same functions: the identity
 * of a caller and the target of a request are the same in both.
 */

export { ipInRanges } from './network'

export { resolveForwardingContext } from './context'
export type { ForwardingContext, ForwardingContextOptions } from './context'

export {
  IDENTITY_SIGNATURE_HEADER,
  IDENTITY_SIGNATURE_VERSION,
  IdentityNotWritableError,
  MAX_IDENTITY_VALUE_LENGTH,
  canonicalIdentityPayload,
  deriveIdentityKey,
  filterRoles,
  isAmbiguousRole,
  sanitizeIdentityValue,
  signIdentity,
  verifyIdentity,
  writtenIdentity,
} from './identity'
export type { CallerIdentity, SignedRequest, WrittenIdentity } from './identity'

export {
  HOP_BY_HOP_HEADERS,
  IDENTITY_HEADER_NAMES,
  IDENTITY_REQUEST_HEADERS,
  buildClientHeaders,
  buildUpstreamHeaders,
  buildWebsocketUpstreamHeaders,
  connectionNominatedHeaders,
  cookieNameOf,
  isGatewaySetCookie,
  stripGatewayCookies,
} from './headers'
export type { UpstreamHeadersOptions } from './headers'

export {
  buildUpstreamTarget,
  buildWebsocketTarget,
  rewriteLocation,
  upstreamOrigin,
} from './target'

export {
  checkCrossSite,
  checkCrossSiteNavigation,
  checkWebsocketOrigin,
  isAllowedOrigin,
  normalizeOrigin,
  requestOrigin,
} from './origins'
export type { CrossSiteCheck, CrossSiteOptions } from './origins'
