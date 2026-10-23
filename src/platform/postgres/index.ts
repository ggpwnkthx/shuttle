/**
 * The platform of the shared state in a Postgres server.
 *
 * The platform builds the clients of the servers and closes them. The
 * tables, the functions, the keys and the behaviour of the stores belong to
 * the domains that own them.
 */

export { createPostgresClient, isConnectionError, isPostgresUrl, PostgresClient } from './client'

export {
  CONTROL_ROLE,
  ensureSchema,
  GATEWAY_ROLE,
  ROLE_GRANTS,
  ROLE_STATEMENTS,
} from './schema'

export { withPostgresRetries } from './commands'
