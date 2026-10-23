/**
 * The authentication domain.
 *
 * The domain owns the principal of a caller, the policy that says which
 * credentials a route accepts, the validation of the credentials against
 * the identity provider, the browser login, the sessions and the cookies of
 * the gateway.
 */

export { AuthPolicySchema } from './policy'

export type { AuthMode, AuthPolicy } from './policy'

export {
  SESSION_COOKIE_NAME,
  serializeCookie,
  sessionCookie,
} from './cookies'

export type { GatewayCookie } from './cookies'

export {
  SessionStoreError,
  cookieMaxAgeSeconds,
  isPastMaximumAge,
  newSessionRecord,
  remainingIdleMs,
  remainingLifetimeMs,
  touchDue,
} from './session'

export type {
  SessionLifetime,
  SessionStore,
} from './session'

export { selectCredential } from './principal'

export type { Principal } from './principal'

export {
  sanitizeRedirectTarget,
  signLoginState,
  verifyLoginState,
} from './login-state'

export type { LoginState } from './login-state'

export {
  OidcClient,
  OidcError,
  extractRoles,
} from './oidc'

export type { OidcPort, VerifiedIdentity } from './oidc'

export { AuthenticationService } from './service'
