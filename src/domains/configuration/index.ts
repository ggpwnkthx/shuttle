/**
 * The configuration domain.
 *
 * The domain owns the schema of the file, the strict validation, the
 * effective defaults, the immutable compiled snapshots and the atomic
 * last-good publication.
 */

export {
  GATEWAY_ENDPOINTS,
  parseConfig,
} from './schema'

export { ConfigurationStore, isReservedPath } from './store'
export type { ConfigurationSnapshot } from './store'

export { describeConfiguration, describeTable } from './describe'

export { compileTable, diffTables, routeDefinitions } from './compile'

export type {
  AuditEntry,
  Page,
  ReplicaHeartbeat,
  RouteTablePointer,
  RouteTableRevision,
  RouteTableStore,
  WriteOutcome,
} from './revisions'

export type { EnvironmentDefaults } from './routes'
