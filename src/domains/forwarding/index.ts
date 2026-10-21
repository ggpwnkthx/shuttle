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
  IDENTITY_SIGNATURE_VERSION_ASYMMETRIC,
  IdentityNotWritableError,
  MAX_IDENTITY_VALUE_LENGTH,
  asymmetricIdentityKey,
  canonicalIdentityPayload,
  deriveIdentityKey,
  filterRoles,
  isAmbiguousRole,
  publicKeyPem,
  sanitizeIdentityValue,
  signIdentity,
  symmetricIdentityKey,
  verificationKeyOf,
  verifyIdentity,
  writtenIdentity,
} from './identity'
export type {
  CallerIdentity,
  IdentityAlgorithm,
  IdentitySigningKey,
  IdentityVerificationKey,
  SignedRequest,
  WrittenIdentity,
} from './identity'

export {
  HOP_BY_HOP_HEADERS,
  IDENTITY_HEADER_NAMES,
  IDENTITY_REQUEST_HEADERS,
  buildClientHeaders,
  buildUpstreamHeaders,
  buildWebsocketUpstreamHeaders,
  connectionNominatedHeaders,
  isGatewaySetCookie,
  stripGatewayCookies,
} from './headers'
export type { UpstreamHeadersOptions } from './headers'

export { cookieNameOf, parseCookieHeader, renderCookieHeader } from './cookies'

export {
  buildUpstreamTarget,
  buildWebsocketTarget,
  rewriteLocation,
  upstreamOrigin,
} from './target'

export {
  TRACEPARENT_HEADER,
  TRACEPARENT_VERSION,
  newSpanId,
  newTraceId,
  parseTraceparent,
  traceContextOf,
  traceparentOf,
} from './trace'
export type { SpanId, TraceContext, TraceId } from './trace'

export {
  checkCrossSite,
  checkCrossSiteNavigation,
  checkWebsocketOrigin,
  isAllowedOrigin,
  normalizeOrigin,
  requestOrigin,
} from './origins'
export type { CrossSiteCheck, CrossSiteOptions } from './origins'
