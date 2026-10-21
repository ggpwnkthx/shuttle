/**
 * The adapters of the workspace access domain.
 *
 * The composition root uses them to build the cache of the decisions of a
 * deployment. The domain itself knows nothing about them.
 */

export { DEFAULT_MAX_DECISIONS, MemoryDecisionCache } from './memory-cache'
export type { MemoryDecisionCacheOptions } from './memory-cache'

export { RedisDecisionCache } from './redis-cache'
export type { RedisCacheCommands, RedisDecisionCacheOptions } from './redis-cache'

export { PostgresDecisionCache } from './postgres-cache'
export type { PostgresCacheCommands, PostgresDecisionCacheOptions } from './postgres-cache'
