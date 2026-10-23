/**
 * The control plane.
 *
 * The control plane is the administrative surface of a deployment. It is a
 * separate process, it listens on its own socket and it acts on the shared
 * state directly: the gateway exposes no administrative endpoint and
 * accepts no administrative token (§12.7 of the specification).
 *
 * The domain owns the policy of the administrative writes: the scopes of
 * the tokens, the routes a write may not change, and the rules of the
 * writes themselves.
 */

export {
  findControlIdentity,
  parseControlTokens,
  parseProtectedRoutes,
  scopeAllows,
} from './policy'
export type { ControlCapability, ControlIdentity } from './policy'

export { ControlService } from './service'
export type { AuthFailureCounter } from './service'
