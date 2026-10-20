/**
 * The authentication domain.
 *
 * The domain owns the principal of a caller, the policy that says which
 * credentials a route accepts, the validation of the credentials against
 * the identity provider, the browser login, the sessions and the cookies of
 * the gateway.
 */

export {
  AuthModeSchema,
  AuthPolicySchema,
  DEFAULT_AUTH_POLICY,
  WorkspacePolicySchema,
} from './policy'
export type { AuthMode, AuthPolicy, WorkspacePolicy } from './policy'

export {
  GATEWAY_COOKIE_NAMES,
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
  loginStateCookie,
  loginStateDeletionCookie,
  serializeCookie,
  sessionCookie,
  sessionDeletionCookie,
} from './cookies'
export type { CookieOptions, GatewayCookie, GatewayCookieAttributes } from './cookies'

export {
  SessionStoreError,
  cookieMaxAgeSeconds,
  isPastIdleLifetime,
  isPastMaximumAge,
  newSessionId,
  newSessionRecord,
  parseSessionRecord,
  remainingIdleMs,
  remainingLifetimeMs,
  serializeSessionRecord,
  touchDue,
} from './session'
export type {
  CreateSessionInput,
  SessionLifetime,
  SessionRecord,
  SessionStore,
} from './session'

export { parseBearerToken, selectCredential } from './principal'
export type {
  BearerToken,
  CredentialInput,
  CredentialPlan,
  CredentialRefusal,
  Principal,
} from './principal'

export {
  LOGIN_STATE_TTL_MS,
  sanitizeRedirectTarget,
  signLoginState,
  verifyLoginState,
} from './login-state'
export type { LoginState } from './login-state'

export {
  ACCEPTED_ALGORITHMS,
  CLOCK_TOLERANCE_SECONDS,
  OidcClient,
  OidcError,
  extractRoles,
} from './oidc'
export type { OidcClientOptions, OidcPort, VerifiedIdentity } from './oidc'

export { AuthenticationService } from './service'
export type {
  AuthenticationOutcome,
  AuthenticationServiceOptions,
  AuthLogger,
  BeginLoginOutcome,
  CompleteLoginOutcome,
} from './service'
