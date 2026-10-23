/**
 * The matching of the routes.
 *
 * A route is a host and a path template. The matcher is deterministic: the
 * routes are sorted by the documented precedence once, and the first route
 * that matches the host and the path of a request handles it.
 *
 * Precedence (the highest wins):
 *
 * 1. the specificity of the host: an exact host, then a wildcard
 *    (`*.example.com`), then the catch-all (`*`);
 * 2. the method: a route that names the method of the request wins over a
 *    route that names none;
 * 3. the length of the literal prefix of the path template (the part in
 *    front of the first placeholder);
 * 4. the number of segments of the template;
 * 5. the id of the route, alphabetically.
 *
 * The **host comes first**: a route of a more specific host is never
 * shadowed by a route of a less specific one, not even when the less
 * specific one names the method of the request. A catch-all that names
 * `GET` used to handle the `GET` of a host that had a route of its own,
 * and the policy of that route — its authentication, its limits, its
 * upstream — was never applied to those requests.
 *
 * Two routes that could match exactly the same request (the same kind of
 * host with the same value and the same template skeleton) are ambiguous and
 * are refused when the configuration is loaded.
 */

import { match, parse, type MatchFunction, type ParamData } from 'path-to-regexp'
import { REST_PLACEHOLDER, normalizeHost, parseHostPattern, type HostPattern } from './schema'

/** A segment of a path template. */
export type PathSegment = { kind: 'literal'; value: string } | { kind: 'param'; name: string }

/** A segment of a rewrite: a literal or a placeholder. */
export type RewriteSegment = { kind: 'literal'; value: string } | { kind: 'param'; name: string }

/**
 * The identity of a route, as the matcher knows it.
 *
 * The matcher does not know the policy of a route: it knows the id, the
 * host and the path, and it carries the payload of the route (the policy)
 * without looking at it.
 */
export interface RouteMatchDefinition {
  id: string
  host: string
  path: string
  /** The path the route forwards to its upstream, when it is not the path of the request. */
  rewrite?: string
  /**
   * The methods the route accepts.
   *
   * An empty list means every method. The methods are upper cased.
   */
  methods?: readonly string[]
}

/** The order of the routes, as a comparable tuple. */
export type Precedence = readonly [number, number, number, string]

/** A route that was prepared for the matching. */
export interface CompiledRoute<TPayload = unknown> {
  id: string
  definition: RouteMatchDefinition
  host: HostPattern
  /**
   * The methods the route accepts, upper cased.
   *
   * An empty list means that the route accepts every method.
   */
  methods: readonly string[]
  /** The template in the syntax of the matcher. */
  template: string
  /** The segments of the template. */
  segments: PathSegment[]
  /** The number of characters of the path that are known before the first placeholder. */
  literalPrefixLength: number
  /** The canonical shape of the template; the placeholders are all the same. */
  skeleton: string
  /** The segments of the rewrite, when the route rewrites the path. */
  rewrite?: RewriteSegment[]
  precedence: Precedence
  /** The policy of the route, as the configuration domain built it. */
  payload: TPayload
}

/** The route that handled a request, with the parameters of its path. */
export interface RouteMatch<TPayload = unknown> {
  route: CompiledRoute<TPayload>
  /** The values of the placeholders of the path, percent decoded. */
  params: Record<string, string>
  /**
   * The part of the path the route matched, as it was received.
   *
   * The request path is forwarded unchanged, so the upstream application
   * sees the prefix as part of its own paths — unless the route rewrites
   * the path.
   */
  prefix: string
  /**
   * The path that is forwarded to the upstream.
   *
   * It is the path of the request when the route does not rewrite it, and
   * the rewritten path when it does.
   */
  path: string
}

/** A template that the matcher cannot use. */
export class RouteTemplateError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RouteTemplateError'
    this.cause = cause
  }
}

/**
 * Translates the template syntax of the gateway into the one of the
 * matcher.
 *
 * `{placeholder}` becomes `:placeholder`. The trailing separator of the
 * template is optional: `/ws/{id}/` matches `/ws/abc` as well as
 * `/ws/abc/assets`, because the upstream application is mounted under the
 * prefix.
 */
function toMatcherTemplate(template: string): string {
  const trimmed = template.replace(/\/+$/, '')
  return trimmed.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1')
}

/** The segments of a template, as the matcher parsed them. */
function segmentsOf(template: string): PathSegment[] {
  let tokens: ReturnType<typeof parse>['tokens']
  try {
    tokens = parse(template).tokens
  } catch (error) {
    throw new RouteTemplateError(
      `the path template "${template}" is not valid: ${error instanceof Error ? error.message : String(error)}`,
      error
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
 * The number of characters of the path that are known before the first
 * placeholder.
 *
 * The more of them a template has, the more specific it is.
 */
function literalPrefixLength(segments: PathSegment[]): number {
  const literals: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'param') break
    literals.push(segment.value)
  }
  if (literals.length === 0) return 0
  const prefix = `/${literals.join('/')}`
  // A trailing separator still counts: it makes the prefix more specific.
  return segments.length > literals.length ? prefix.length + 1 : prefix.length
}

/** The canonical shape of a template: the placeholders are all the same. */
function skeletonOf(segments: PathSegment[]): string {
  return segments.map((segment) => (segment.kind === 'literal' ? segment.value : '{}')).join('/')
}

/**
 * The names of the placeholders of a template.
 *
 * The configuration uses them to check that a workspace check refers to a
 * placeholder that exists: a policy that names a placeholder the path does
 * not have could never be satisfied.
 */
export function placeholderNames(template: string): string[] {
  const names: string[] = []
  for (const segment of template.split('/')) {
    const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment)
    if (match) names.push(match[1]!)
  }
  return names
}

/**
 * The segments of a rewrite.
 *
 * A rewrite is a list of segments like a path template. The placeholder
 * `{rest}` stands for the part of the path that follows the prefix the
 * route matched, and it may only be the last segment.
 */
function rewriteSegmentsOf(template: string): RewriteSegment[] {
  const segments: RewriteSegment[] = []
  const parts = template.split('/').filter((segment) => segment !== '')
  for (const [index, part] of parts.entries()) {
    const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part)
    if (!match) {
      segments.push({ kind: 'literal', value: part })
      continue
    }
    const name = match[1]!
    if (name === REST_PLACEHOLDER) {
      if (index !== parts.length - 1) {
        throw new RouteTemplateError(
          `the rewrite "${template}" uses the placeholder "{rest}" and it is not the last segment: the rest of the path is the end of the path`
        )
      }
      segments.push({ kind: 'param', name: REST_PLACEHOLDER })
      continue
    }
    segments.push({ kind: 'param', name })
  }
  return segments
}

/**
 * The part of the path that follows the prefix the route matched.
 *
 * It is empty when the request path is the prefix, and it never starts with
 * a slash: it is a list of segments.
 */
function restOf(path: string, prefix: string): string {
  if (prefix === '/' || prefix === '') return path === '/' ? '' : path.replace(/^\//, '')
  if (!path.startsWith(prefix)) return ''
  return path.slice(prefix.length).replace(/^\//, '')
}

/**
 * Builds the path that is forwarded to the upstream.
 *
 * The rewrite is a list of segments: a literal is used as it is, a
 * placeholder of the path of the route is the value the caller sent, and
 * `{rest}` is the part of the path that follows the prefix the route
 * matched.
 *
 * The values are the ones of the request as they were received: the
 * encoding of the path is not touched, so a value that carries an encoded
 * character reaches the upstream as it was sent.
 */
export function rewrittenPath(
  segments: readonly RewriteSegment[],
  params: Record<string, string>,
  rest: string
): string {
  const parts: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'literal') {
      parts.push(segment.value)
      continue
    }
    if (segment.name === REST_PLACEHOLDER) {
      if (rest !== '') parts.push(rest)
      continue
    }
    const value = params[segment.name]
    if (value === undefined) continue
    parts.push(value)
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

/** Prepares a route for the matching. */
export function compileRoute<TPayload>(
  definition: RouteMatchDefinition,
  payload: TPayload
): CompiledRoute<TPayload> {
  const host = parseHostPattern(definition.host)
  const template = toMatcherTemplate(definition.path)
  const segments = segmentsOf(template)
  const literal = literalPrefixLength(segments)
  const hostRank = host.kind === 'exact' ? 0 : host.kind === 'wildcard' ? 1 : 2
  const rewrite = definition.rewrite ? rewriteSegmentsOf(definition.rewrite) : undefined
  const methods = [
    ...new Set((definition.methods ?? []).map((method) => method.toUpperCase())),
  ].sort()
  return {
    id: definition.id,
    definition,
    host,
    methods,
    template,
    segments,
    literalPrefixLength: literal,
    skeleton: skeletonOf(segments),
    rewrite,
    precedence: [hostRank, -literal, -segments.length, definition.id],
    payload,
  }
}

/** Sorts the routes by the documented precedence. */
export function sortRoutes<TPayload>(routes: CompiledRoute<TPayload>[]): CompiledRoute<TPayload>[] {
  return [...routes].sort((left, right) => {
    for (let index = 0; index < left.precedence.length; index++) {
      const a = left.precedence[index]!
      const b = right.precedence[index]!
      if (a < b) return -1
      if (a > b) return 1
    }
    return 0
  })
}

/**
 * Reports whether a host matches the pattern of a route.
 *
 * The host of the request is normalized before the comparison: the port and
 * the trailing dot are not part of the name of the host.
 */
export function hostMatches(pattern: HostPattern, host: string): boolean {
  switch (pattern.kind) {
    case 'any':
      return true
    case 'exact':
      return host === pattern.value
    case 'wildcard':
      // A wildcard matches the subdomains, not the domain itself.
      return host.endsWith(`.${pattern.value}`)
  }
}

/**
 * The matcher of a path template.
 *
 * The template matches a path when the path starts with it: the upstream
 * application mounted under `/ws/{id}/` receives every request below that
 * prefix.
 */
function matcherFor(route: CompiledRoute<unknown>): MatchFunction<ParamData> {
  try {
    // The values of the placeholders are decoded by the gateway itself: a
    // value that cannot be decoded makes the request unmatched, and not a
    // match with a broken identifier.
    return match(route.template, {
      end: false,
      decode: (value: string) => value,
    })
  } catch (error) {
    throw new RouteTemplateError(
      `the path template of the route "${route.id}" is not valid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error
    )
  }
}

/**
 * Finds the route that handles a request.
 *
 * The routes are expected to be sorted by `sortRoutes`, but the order of
 * the list is not what decides: every route that matches the request is
 * compared with the documented precedence, and the best one wins.
 *
 * A route is a candidate when it matches the host of the request, when its
 * path template matches the path of the request, and when it names the
 * method of the request or no method at all. A route that names other
 * methods does not handle the request.
 *
 * The candidates are then compared:
 *
 * - the specificity of the host comes first, so a route of a more specific
 *   host is never shadowed by a route of a less specific one;
 * - the method comes next: one that names the method of the request wins
 *   over one that names none;
 * - the specificity of the path and the id of the route break the ties.
 */
export function matchRoute<TPayload>(
  routes: readonly CompiledRoute<TPayload>[],
  host: string,
  path: string,
  method?: string
): RouteMatch<TPayload> | null {
  const normalizedHost = normalizeHost(host)
  const wanted = method === undefined ? null : method.toUpperCase()

  let winner: CompiledRoute<TPayload> | null = null
  let winnerResult: { path: string; params: Partial<Record<string, string | string[]>> } | null =
    null
  let winnerMethodRank = 0

  for (const route of routes) {
    const names = route.methods.length > 0
    // A route that names the methods it accepts handles the request only
    // for those methods.
    if (names && (wanted === null || !route.methods.includes(wanted))) continue
    if (!hostMatches(route.host, normalizedHost)) continue
    const result = matcherFor(route as CompiledRoute<unknown>)(path)
    if (!result) continue
    // The routes that name the method of the request are the ones that
    // were written for it: they win over the routes that name none.
    const methodRank = names ? 0 : 1
    if (winner === null || isBetter(route, methodRank, winner, winnerMethodRank)) {
      winner = route
      winnerResult = result
      winnerMethodRank = methodRank
    }
  }

  if (winner === null || winnerResult === null) return null
  const match = buildMatch(winner, path, winnerResult)
  if (match === null) return null
  return match
}

/**
 * Reports whether a candidate wins over the route that is already the
 * winner.
 *
 * The comparison follows the documented precedence: the specificity of the
 * host, then the method, then the specificity of the path and the id.
 */
function isBetter<TPayload>(
  candidate: CompiledRoute<TPayload>,
  candidateMethodRank: number,
  incumbent: CompiledRoute<TPayload>,
  incumbentMethodRank: number
): boolean {
  const a = candidate.precedence
  const b = incumbent.precedence
  // The host: an exact host wins over a wildcard, and a wildcard wins over
  // the catch-all.
  if (a[0] !== b[0]) return a[0] < b[0]
  // The method: a route that names the method of the request wins over a
  // route that names none.
  if (candidateMethodRank !== incumbentMethodRank) {
    return candidateMethodRank < incumbentMethodRank
  }
  // The path and the id.
  for (let index = 1; index < a.length; index++) {
    const left = a[index]!
    const right = b[index]!
    if (left < right) return true
    if (left > right) return false
  }
  return false
}

/**
 * Builds the match of a route, with the values of its placeholders.
 *
 * It returns null when a placeholder cannot be decoded: a route that
 * matched with an unusable identifier would forward a request whose
 * identifier is missing, which is a different request than the one the
 * route describes.
 */
function buildMatch<TPayload>(
  route: CompiledRoute<TPayload>,
  path: string,
  result: { path: string; params: Partial<Record<string, string | string[]>> }
): RouteMatch<TPayload> | null {
  const params: Record<string, string> = {}
  const rawParams: Record<string, string> = {}
  for (const [name, value] of Object.entries(result.params)) {
    if (typeof value !== 'string') continue
    // The raw value is the one the caller sent: it is what a rewrite
    // writes into the path of the upstream, so the encoding of the path
    // is not touched.
    rawParams[name] = value
    let decoded: string
    try {
      decoded = decodeURIComponent(value)
    } catch {
      return null
    }
    params[name] = decoded
  }
  const forwarded = route.rewrite
    ? rewrittenPath(route.rewrite, rawParams, restOf(path, result.path))
    : path
  return { route, params, prefix: result.path, path: forwarded }
}

/**
 * Reports the conflicts of a route table.
 *
 * An empty list means the table is unambiguous. The conflicts are refused
 * when the configuration is loaded: a table that is ambiguous would make the
 * answer of the gateway depend on the order of the file.
 */
export function detectConflicts<TPayload>(routes: CompiledRoute<TPayload>[]): string[] {
  const conflicts: string[] = []
  const seen = new Map<string, CompiledRoute<TPayload>>()
  for (const route of routes) {
    if (seen.has(route.id)) {
      conflicts.push(`duplicate route id "${route.id}"`)
      continue
    }
    seen.set(route.id, route)
  }

  for (let left = 0; left < routes.length; left++) {
    for (let right = left + 1; right < routes.length; right++) {
      const a = routes[left]!
      const b = routes[right]!
      if (a.host.kind !== b.host.kind || a.host.value !== b.host.value) continue
      if (a.skeleton !== b.skeleton) continue
      // Two routes that match the same requests are ambiguous. Two routes
      // that name different methods do not match the same requests: they
      // are two halves of one route. A route that names no method is the
      // fallback of the others: it handles the methods that no other route
      // names, so it is not ambiguous with them.
      const aNamed = a.methods.length > 0
      const bNamed = b.methods.length > 0
      if (aNamed !== bNamed) continue
      if (aNamed && !a.methods.some((method) => b.methods.includes(method))) continue
      conflicts.push(
        `the routes "${a.id}" and "${b.id}" are ambiguous: both match the host "${a.definition.host}" with the path template "${a.definition.path}"`
      )
    }
  }

  return conflicts
}

/**
 * A route that another route hides for the hosts of the other one.
 *
 * The precedence of the matcher decides the host before the method, so a
 * route of a more specific host handles the requests of a less specific
 * one — even when the less specific one names the method of the request.
 * A deployment that wrote the catch-all first and the specific host
 * afterwards sees a different route answer, and it deserves to know.
 */
export interface ShadowedRoute {
  /** The route that never handles those requests. */
  routeId: string
  /** The route that handles them instead. */
  byRouteId: string
  /** The host the other route handles. */
  host: string
  /** The methods that are handled by the other route. */
  methods: string[]
}

/**
 * Reports the routes that another route hides for some of its requests.
 *
 * A route is hidden when a route of a more specific host handles the same
 * paths and one of the methods it names. The routes that name no method are
 * not reported: the host decides for them, and that is the documented
 * precedence.
 */
export function detectShadowedRoutes<TPayload>(
  routes: readonly CompiledRoute<TPayload>[]
): ShadowedRoute[] {
  const shadowed: ShadowedRoute[] = []
  for (const general of routes) {
    if (general.host.kind === 'exact') continue
    if (general.methods.length === 0) continue
    for (const specific of routes) {
      if (specific === general) continue
      if (!coversHost(general.host, specific.host)) continue
      if (general.skeleton !== specific.skeleton) continue
      const methods =
        specific.methods.length === 0
          ? [...general.methods]
          : general.methods.filter((method) => specific.methods.includes(method))
      if (methods.length === 0) continue
      shadowed.push({
        routeId: general.id,
        byRouteId: specific.id,
        host: specific.definition.host,
        methods,
      })
    }
  }
  return shadowed
}

/**
 * Reports whether the host of a general route covers the host of a more
 * specific one.
 */
function coversHost(general: HostPattern, specific: HostPattern): boolean {
  if (general.kind === 'any') return true
  if (general.kind !== 'wildcard') return false
  // A wildcard covers the exact hosts of its own domain, and nothing else.
  if (specific.kind === 'wildcard') return specific.value === general.value
  return specific.value.endsWith(`.${general.value}`)
}

/**
 * Reports whether a route claims a path that is reserved.
 *
 * The comparison ignores the trailing slash: a route with the path
 * `/metrics/` claims the path `/metrics` as well.
 */
export function claimsReservedPath(
  route: CompiledRoute<unknown>,
  reservedPaths: readonly string[]
): boolean {
  const claimed = route.definition.path.replace(/\/+$/, '') || '/'
  return reservedPaths.some((reserved) => (reserved.replace(/\/+$/, '') || '/') === claimed)
}
