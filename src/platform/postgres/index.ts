/**
 * The platform of the shared state in a Postgres server.
 *
 * The platform builds the clients of the servers and closes them. The
 * tables, the functions, the keys and the behaviour of the stores belong to
 * the domains that own them.
 */

export { createPostgresClient, isConnectionError, isPostgresUrl, PostgresClient } from './client'
export type {
  PostgresClientOptions,
  PostgresQueryClient,
  PostgresResult,
} from './client'

export {
  BOOTSTRAP_LOCK_KEY,
  ensureSchema,
  SCHEMA_NAME,
  SCHEMA_STATEMENTS,
} from './schema'
export type { SchemaClient } from './schema'

export { withPostgresRetries } from './commands'
export type { PostgresCommands } from './commands'
