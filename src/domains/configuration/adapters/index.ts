/**
 * The adapters of the configuration domain.
 *
 * The composition root uses them to build the store of the route table of
 * a deployment. The domain itself knows nothing about them.
 */

export { PostgresRouteTableStore } from './postgres-route-table'

export { RedisRouteTableStore } from './redis-route-table'
