import { match, parse, type MatchFunction, type ParamData } from 'path-to-regexp'
import { GATEWAY_PATHS, normalizePath, type RouteConfig, type ShuttleConfig } from './schema'

/**
 * Deterministic route matching.
 *
 * Precedence (highest wins):
 *   1. Host specificity: exact host > wildcard host (`*.example.com`) > catch-all (`*`).
 *   2. Longer literal path prefix (the part of the template before the first
 *      placeholder).
 *   3. More path template segments.
 *   4. Route id (alphabetical) as a final, stable tie-breaker.
 *
 * Two routes that could match exactly the same concrete request (same host
 * pattern and the same template skeleton) are ambiguous and rejected when the
 * configuration is loaded.
 *
 * The path templates are matched by `path-to-regexp`: a template matches a
 * path when the path starts with it, so an upstream application mounted
 * under a path prefix receives every request below that prefix.
 */

export type PathSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }

export type HostKind = 'exact' | 'wildcard' | 'any'

export interface CompiledRoute {
  id: string
  route: RouteConfig
  hostKind: HostKind
  /** Lower-cased host value without port. For wildcards this is the suffix. */
  hostValue: string
  /** The template in the syntax of `path-to-regexp`. */
  template: string
  /** The segments of the template, as the library parsed them. */
  segments: PathSegment[]
  /** Length of the literal prefix of the path template. */
  literalPrefixLength: number
  /** Canonical template shape; used to detect ambiguous routes. */
  skeleton: string
  precedence: [number, number, number, string]
}

export interface RouteMatch {
  route: CompiledRoute
  params: Record<string, string>
  /**
   * The part of the request path the route matched, as it was received.
   *
   * It is the prefix the upstream application is mounted under: the request
   * path is forwarded unchanged, so the application sees the prefix as part
   * of its own paths.
   */
  prefix: string
}

export class RouteTemplateError extends Error {}

/**
 * Translates the Shuttle template syntax into the one of `path-to-regexp`.
 *
 * `{placeholder}` becomes `:placeholder`. The trailing separator of the
 * template is optional: `/ws/{id}/` matches `/ws/abc` as well as
 * `/ws/abc/assets`, because the upstream application is mounted under the
 * prefix.
 *
 * The shape of the template is validated by the configuration schema, so the
 * replacement below only ever sees a well formed placeholder.
 */
function toMatcherTemplate(template: string): string {
  const trimmed = template.replace(/\/+$/, '')
  return trimmed.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1')
}

/**
 * The segments of a template, as `path-to-regexp` parsed them.
 *
 * The library owns the parsing of the template: the segments are only read
 * back to compute the precedence of a route and to detect ambiguous routes.
 */
function segmentsOf(template: string): PathSegment[] {
  let tokens: ReturnType<typeof parse>['tokens']
  try {
    tokens = parse(template).tokens
  } catch (error) {
    throw new RouteTemplateError(
      `the path template "${template}" is not valid: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const segments: PathSegment[] = []
  const names = new Set<string>()
  for (const token of tokens) {
    if (token.type === 'text') {
      for (const part of token.value.split('/')) {
        if (part === '') continue
        segments.push({ kind: 'literal', value: part })
      }
      continue
    }
    if (token.type !== 'param') {
      throw new RouteTemplateError(
        `the path template "${template}" uses a feature the gateway does not support`
      )
    }
    if (names.has(token.name)) {
      throw new RouteTemplateError(
        `the path template "${template}" uses the parameter "${token.name}" twice`
      )
    }
    names.add(token.name)
    segments.push({ kind: 'param', name: token.name })
  }
  return segments
}

/**
 * The length of the literal prefix of a template.
 *
 * It is the number of characters of the path that are known before the first
 * placeholder: the more of them a template has, the more specific it is.
 */
function literalPrefixLength(segments: PathSegment[]): number {
  const literals: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'param') break
    literals.push(segment.value)
  }
  if (literals.length === 0) return 0
  const prefix = '/' + literals.join('/')
  // A trailing separator still counts: it makes the prefix more specific.
  return segments.length > literals.length ? prefix.length + 1 : prefix.length
}

/** The canonical shape of a template: the placeholders are all the same. */
function skeletonOf(segments: PathSegment[]): string {
  return segments.map((segment) => (segment.kind === 'literal' ? segment.value : '{}')).join('/')
}

function hostKindOf(pattern: string): { kind: HostKind; value: string } {
  const value = pattern.trim().toLowerCase()
  if (value === '*') return { kind: 'any', value: '' }
  if (value.startsWith('*.')) return { kind: 'wildcard', value: value.slice(2) }
  return { kind: 'exact', value }
}

function compileRoute(route: RouteConfig): CompiledRoute {
  const hostKind = hostKindOf(route.match.host)
  const template = toMatcherTemplate(route.match.path)
  const segments = segmentsOf(template)
  const literal = literalPrefixLength(segments)
  const hostRank = hostKind.kind === 'exact' ? 0 : hostKind.kind === 'wildcard' ? 1 : 2
  return {
    id: route.id,
    route,
    hostKind: hostKind.kind,
    hostValue: hostKind.value,
    template,
    segments,
    literalPrefixLength: literal,
    skeleton: skeletonOf(segments),
    precedence: [hostRank, -literal, -segments.length, route.id],
  }
}

export function compileRoutes(config: ShuttleConfig): CompiledRoute[] {
  return config.routes.map(compileRoute)
}

/**
 * Returns a list of human readable conflicts. An empty list means the route
 * table is unambiguous.
 *
 * The reserved paths of the configuration are checked as well, so an
 * operator that reserves a path for the gateway cannot shadow it with a
 * route either.
 */
export function detectConflicts(
  routes: CompiledRoute[],
  reservedPaths: string[] = []
): string[] {
  const conflicts: string[] = []
  const seenIds = new Map<string, CompiledRoute>()
  for (const route of routes) {
    const existing = seenIds.get(route.id)
    if (existing) {
      conflicts.push(`duplicate route id "${route.id}"`)
    } else {
      seenIds.set(route.id, route)
    }
  }

  // A route must not claim a path the gateway serves itself. The gateway
  // handles these paths before the route table is consulted, so such a route
  // would never receive a request — it would only be a sign that the
  // configuration is wrong. The comparison ignores the trailing slash: a
  // route with the path `/metrics/` claims the path `/metrics` as well.
  const reserved = [...GATEWAY_PATHS, ...reservedPaths]
  for (const route of routes) {
    const claimed = normalizePath(route.route.match.path)
    for (const reservedPath of reserved) {
      if (normalizePath(reservedPath) === claimed) {
        conflicts.push(
          `route "${route.id}" claims the reserved path "${reservedPath}", which the gateway serves itself`
        )
      }
    }
  }

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!
      const b = routes[j]!
      if (a.hostKind !== b.hostKind || a.hostValue !== b.hostValue) continue
      if (a.skeleton !== b.skeleton) continue
      conflicts.push(
        `routes "${a.id}" and "${b.id}" are ambiguous: both match host "${a.route.match.host}" with path template "${a.route.match.path}"`
      )
    }
  }
  return conflicts
}

/** Strips the port and trailing dot from a Host header value. */
function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end !== -1) value = value.slice(1, end)
  } else {
    const colon = value.indexOf(':')
    if (colon !== -1) value = value.slice(0, colon)
  }
  if (value.endsWith('.')) value = value.slice(0, -1)
  return value
}

function hostMatches(route: CompiledRoute, host: string): boolean {
  switch (route.hostKind) {
    case 'any':
      return true
    case 'exact':
      return host === route.hostValue
    case 'wildcard':
      return host.endsWith('.' + route.hostValue)
  }
}

/** Sorts routes by the documented precedence rules. */
export function sortRoutes(routes: CompiledRoute[]): CompiledRoute[] {
  return [...routes].sort((a, b) => {
    for (let i = 0; i < a.precedence.length; i++) {
      const left = a.precedence[i]!
      const right = b.precedence[i]!
      if (left < right) return -1
      if (left > right) return 1
    }
    return 0
  })
}

/**
 * The matcher of a path template.
 *
 * The template matches a path when the path starts with it: the upstream
 * application mounted under `/ws/{id}/` receives every request below that
 * prefix. The trailing separator of the template is optional.
 */
function matcherFor(route: CompiledRoute): MatchFunction<ParamData> {
  try {
    return match(route.template, { end: false, decode: (value: string) => value })
  } catch (error) {
    throw new RouteTemplateError(
      `the path template "${route.template}" is not valid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Finds the route that should handle the given host + path. */
export function matchRoute(
  routes: CompiledRoute[],
  host: string,
  path: string
): RouteMatch | null {
  const normalizedHost = normalizeHost(host)
  for (const route of routes) {
    if (!hostMatches(route, normalizedHost)) continue
    const result = matcherFor(route)(path)
    if (!result) continue
    const params: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.params)) {
      if (typeof value !== 'string') continue
      let decoded: string
      try {
        decoded = decodeURIComponent(value)
      } catch {
        // A malformed percent encoding is not a path the route can match.
        // The whole request is not matched: a route that matched with an
        // unusable placeholder would forward a request whose identifier is
        // missing, which is a different request than the one the route
        // describes.
        return null
      }
      params[name] = decoded
    }
    return { route, params, prefix: result.path }
  }
  return null
}
