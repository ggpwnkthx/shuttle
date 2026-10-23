/**
 * The configuration domain.
 *
 * The domain owns the schema of the configuration file, the effective
 * defaults of the routes, the compiled generations and the publication of
 * the last good one.
 */

export {
  GATEWAY_ENDPOINTS,
  parseConfig,
} from './schema'

export { ConfigurationStore, isReservedPath } from './store'
export type { ConfigurationSnapshot } from './store'

export { describeConfiguration } from './describe'
