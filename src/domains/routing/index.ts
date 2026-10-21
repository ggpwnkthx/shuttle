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
  HOST_PATTERN_MAX,
  HostPatternSchema,
  PARAM_NAME_PATTERN,
  PATH_TEMPLATE_MAX,
  PathTemplateSchema,
  REST_PLACEHOLDER,
  ROUTE_ID_PATTERN,
  RewriteTemplateSchema,
  RouteIdSchema,
  isValidHostPattern,
  isValidPathTemplate,
  isValidRewriteTemplate,
  normalizeHost,
  parseHostPattern,
} from './schema'
export type { HostKind, HostPattern } from './schema'

export {
  RouteTemplateError,
  claimsReservedPath,
  compileRoute,
  detectConflicts,
  hostMatches,
  matchRoute,
  placeholderNames,
  rewrittenPath,
  sortRoutes,
} from './match'
export type {
  CompiledRoute,
  PathSegment,
  Precedence,
  RewriteSegment,
  RouteMatch,
  RouteMatchDefinition,
} from './match'
