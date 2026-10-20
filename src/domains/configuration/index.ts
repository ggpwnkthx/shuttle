/**
 * The configuration domain.
 *
 * The domain owns the schema of the configuration file, the effective
 * defaults of the routes, the compiled generations and the publication of
 * the last good one.
 */

export {
  ConfigValidationError,
  DefaultsSchema,
  GATEWAY_ENDPOINTS,
  GATEWAY_RESERVED_PATHS,
  MAX_BODY_BYTES_LIMIT,
  RouteSchema,
  RouteTimeoutsSchema,
  ShuttleConfigSchema,
  TimeoutsSchema,
  effectivePolicy,
  parseConfig,
} from './schema'
export type {
  Defaults,
  RouteFile,
  RouteTimeouts,
  ShuttleConfigFile,
  Timeouts,
} from './schema'

export { ConfigurationStore, isReservedPath } from './store'
export type {
  ConfigErrorState,
  ConfigStatus,
  ConfigurationSnapshot,
  ConfigurationStoreOptions,
  EffectiveRoute,
  ReloadResult,
} from './store'
