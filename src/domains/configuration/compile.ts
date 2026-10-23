/**
 * The compilation of a route table.
 *
 * A table is compiled *before* it is used: the routes are parsed, the
 * policy of every route is computed and the table is checked for ambiguity
 * (§3.2 of the specification). A table that is ambiguous is refused as a
 * whole, because a table that is half applied is a table nobody can reason
 * about.
 *
 * The compilation is a pure function of the table and of the defaults of
 * the deployment: the gateway publishes the result, and the control plane
 * compiles a table it never publishes (§12.7 of the specification). Both
 * get the same answer, because they call the same function.
 */

import { claimsReservedPath, detectConflicts, type CompiledRoute } from '../routing'
import {
  ConfigValidationError,
  GATEWAY_RESERVED_PATHS,
  parseConfig,
  type ShuttleConfigFile,
} from './schema'
import { compileRoutes, type EffectiveRoute, type EnvironmentDefaults } from './routes'

/** A table that compiled. */
export interface CompiledTable {
  /** The routes, sorted by the precedence of the matcher. */
  routes: CompiledRoute<EffectiveRoute>[]
  /** The paths the gateway reserves for itself. */
  reservedPaths: string[]
  /** The ranges whose forwarding headers are trusted. */
  trustedProxies: string[]
}

/** The outcome of the compilation of a table. */
export type CompileResult =
  | { ok: true; table: CompiledTable }
  | { ok: false; errors: string[]; conflicts: string[] }

/**
 * Compiles a route table.
 *
 * The errors are the ones of the schema of the table: a field that is
 * unknown, a value that is out of range. The conflicts are the ones of the
 * matching: two routes that could match the same request, a route that
 * claims a path the gateway serves itself.
 *
 * The ranges of the trusted proxies are the ones of the environment when
 * the environment names them, and the ones of the file otherwise: an
 * operator that names the proxies of the deployment in the environment is
 * not surprised by the ranges of the file, and a deployment that names
 * them in the file keeps them.
 */
export function compileTable(
  raw: unknown,
  defaults: EnvironmentDefaults,
  trustedProxies: string[] = [],
  trustedProxiesConfigured: boolean = false
): CompileResult {
  let config: ShuttleConfigFile
  try {
    config = parseConfig(raw)
  } catch (error) {
    const details = error instanceof ConfigValidationError ? error.details : [String(error)]
    return { ok: false, errors: details, conflicts: [] }
  }

  const routes = compileRoutes(config.routes, config.defaults, defaults)
  const conflicts = detectConflicts(routes)
  for (const route of routes) {
    if (claimsReservedPath(route, [...GATEWAY_RESERVED_PATHS, ...config.reservedPaths])) {
      conflicts.push(
        `the route "${route.id}" claims the reserved path "${route.definition.path}", which the gateway serves itself`
      )
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, errors: [], conflicts }
  }

  return {
    ok: true,
    table: {
      routes,
      reservedPaths: [...config.reservedPaths],
      trustedProxies: trustedProxiesConfigured ? [...trustedProxies] : [...config.trustedProxies],
    },
  }
}

/** The difference between two route tables. */
export interface TableDiff {
  /** The ids of the routes the candidate adds. */
  added: string[]
  /** The ids of the routes the candidate removes. */
  removed: string[]
  /** The ids of the routes the candidate changes. */
  changed: string[]
}

/**
 * Compares two route tables.
 *
 * The comparison is by route id: a route that is added, removed or
 * changed is named. The operator sees what a write does before it writes
 * it, which is the point of the diff (§12.7 of the specification).
 */
export function diffTables(active: unknown, candidate: unknown): TableDiff {
  const before = routesOf(active)
  const after = routesOf(candidate)
  const beforeIds = new Set(before.keys())
  const afterIds = new Set(after.keys())
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const id of afterIds) {
    if (!beforeIds.has(id)) added.push(id)
    else if (before.get(id) !== after.get(id)) changed.push(id)
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) removed.push(id)
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

/**
 * The routes of a table, by id, with their canonical form.
 *
 * The comparison of two routes is by their canonical form: two tables that
 * carry the same route in a different order hold the same route.
 */
export function routeDefinitions(raw: unknown): { id: string; definition: string }[] {
  return [...routesOf(raw)].map(([id, definition]) => ({ id, definition }))
}

/** The routes of a table, by id, with their canonical form. */
function routesOf(raw: unknown): Map<string, string> {
  const routes = new Map<string, string>()
  let config: ShuttleConfigFile
  try {
    config = parseConfig(raw)
  } catch {
    // A table that does not parse has no route to compare: the diff is
    // empty and the errors of the schema are reported next to it.
    return routes
  }
  for (const route of config.routes) {
    routes.set(route.id, canonical(route))
  }
  return routes
}

/**
 * The canonical form of a route.
 *
 * The keys are sorted, so two tables that carry the same route in a
 * different order compare equal: the order of the keys of a json object
 * is not a difference of the table.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
