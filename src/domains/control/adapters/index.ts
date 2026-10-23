/**
 * The adapters of the control plane.
 *
 * The composition root uses them to build the counter of the failures of
 * the authentication. The domain itself knows nothing about them.
 */

export { PostgresAuthFailureCounter } from './postgres-failures'

export { RedisAuthFailureCounter } from './redis-failures'
