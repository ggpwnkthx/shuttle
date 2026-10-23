/**
 * The workspace access domain.
 *
 * The domain owns the validation of the identifier of a workspace, the
 * requests to the access service, the keys of the cached decisions and the
 * failures of the service.
 *
 * The domain never evaluates the roles of a caller: it asks the access
 * service and it fails closed.
 */

export { authFailureReason } from './decision'

export { isUuid, validateWorkspace } from './workspace'

export { AccessClient, decisionKey } from './client'
export type {
  AccessTransport,
  CachedDecision,
  DecisionCache,
} from './client'
