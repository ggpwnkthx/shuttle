/**
 * The platform of the shared state.
 *
 * The platform builds the clients of the Redis servers and closes them. The
 * keys of the server, the scripts and the behaviour of the stores belong to
 * the domains that own them.
 */

export { createRedisClient, isConnectionError, isRedisUrl } from './client'
export type { SharedStateClient } from './client'

export { withRetries } from './commands'
