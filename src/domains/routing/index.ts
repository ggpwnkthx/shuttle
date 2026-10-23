/**
 * The routing domain.
 *
 * The domain owns the identity of a route, the shape of the hosts and of the
 * paths it matches, the parameters of a path, the precedence of the routes
 * and the detection of the tables that are ambiguous.
 *
 * The domain knows nothing about the environment, about the reload of the
 * configuration and about the policy of a route: it matches a host and a
 * path and it hands the payload of the route back untouched.
 */

export {
  HostPatternSchema,
  MethodsSchema,
  PathTemplateSchema,
  REST_PLACEHOLDER,
  RewriteTemplateSchema,
  RouteIdSchema,
  normalizeHost,
} from './schema'

export {
  claimsReservedPath,
  compileRoute,
  detectConflicts,
  detectShadowedRoutes,
  matchRoute,
  placeholderNames,
  sortRoutes,
} from './match'

export type {
  CompiledRoute,
  RouteMatchDefinition,
} from './match'
