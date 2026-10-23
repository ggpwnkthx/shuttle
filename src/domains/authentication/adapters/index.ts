/**
 * The adapters of the authentication domain.
 *
 * The composition root uses them to build the store of the sessions of a
 * deployment. The domain itself knows nothing about them.
 */

export { MemorySessionStore } from './memory-sessions'

export { RedisSessionStore } from './redis-sessions'

export { PostgresSessionStore } from './postgres-sessions'
