/**
 * The adapters of the authentication domain.
 *
 * The composition root uses them to build the store of the sessions of a
 * deployment. The domain itself knows nothing about them.
 */

export { DEFAULT_MAX_SESSIONS, MemorySessionStore } from './memory-sessions'
export type { MemorySessionStoreOptions } from './memory-sessions'

export { RedisSessionStore, TOUCH_SCRIPT } from './redis-sessions'
export type { RedisSessionCommands, RedisSessionStoreOptions } from './redis-sessions'

export { PostgresSessionStore } from './postgres-sessions'
export type {
  PostgresSessionCommands,
  PostgresSessionStoreOptions,
} from './postgres-sessions'
