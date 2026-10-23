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

export { resolveForwardingContext } from './context'
export type { ForwardingContext } from './context'

export {
  IdentityNotWritableError,
  asymmetricIdentityKey,
  canonicalIdentityPayload,
  ephemeralIdentityKey,
  publicKeyPem,
  sanitizeIdentityValue,
  signIdentity,
  verificationKeyOf,
  verifyIdentity,
  writtenIdentity,
} from './identity'

export type {
  CallerIdentity,
  IdentitySigningKey,
  SignedRequest,
  WrittenIdentity,
} from './identity'

export {
  buildClientHeaders,
  buildUpstreamHeaders,
  buildWebsocketUpstreamHeaders,
  connectionNominatedHeaders,
  stripGatewayCookies,
} from './headers'

export { cookieNameOf, parseCookieHeader, renderCookieHeader } from './cookies'

export {
  buildUpstreamTarget,
  buildWebsocketTarget,
  rewriteLocation,
  upstreamOrigin,
} from './target'

export {
  TRACEPARENT_HEADER,
  newSpanId,
  newTraceId,
  parseTraceparent,
  traceContextOf,
  traceparentOf,
} from './trace'

export {
  checkCrossSite,
  checkCrossSiteNavigation,
  checkWebsocketOrigin,
  normalizeOrigin,
  requestOrigin,
} from './origins'
