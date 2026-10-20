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
