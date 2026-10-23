/**
 * The policy of the control plane.
 *
 * The control plane is the only thing that writes the route table of a
 * deployment (§12.7 of the specification). The policy it applies lives
 * here: who may write what, and what a write is allowed to change.
 *
 * The policy is a plain value and it holds nothing of the gateway: it may
 * be written in a log, printed by a command or compared in a test.
 */

/** What a token may do. */
export type ControlScope = 'read' | 'operate' | 'config'

/** The capabilities of the scopes. */
export type ControlCapability = 'read' | 'operate' | 'config'

/**
 * The capabilities of every scope.
 *
 * The scopes are not a chain: `operate` may revoke a session but it may
 * not write the route table, and `config` may write the route table but it
 * may not revoke a session. A token holds exactly one scope, and the
 * capability of the scope decides what the token may do.
 */
export const SCOPE_CAPABILITIES: Readonly<Record<ControlScope, readonly ControlCapability[]>> = {
  read: ['read'],
  operate: ['read', 'operate'],
  config: ['read', 'config'],
}

/** The scopes of the control plane. */
export const CONTROL_SCOPES: readonly ControlScope[] = ['read', 'operate', 'config']

/** The shortest token the control plane accepts. */
export const MINIMUM_TOKEN_LENGTH = 16

/** The identity of the operator behind a token. */
export interface ControlIdentity {
  /** The operator, as the token map named it. */
  operator: string
  /** The scope the token holds. */
  scope: ControlScope
}

/** The tokens the control plane accepts, by the token itself. */
export type ControlTokens = ReadonlyMap<string, ControlIdentity>

/**
 * Reads the token map.
 *
 * The map is a JSON object of `{token: {operator, scope}}`. A map that
 * cannot be read stops the process: a control plane that starts with a map
 * it does not understand is a control plane that nobody controls.
 */
export function parseControlTokens(raw: string): ControlTokens {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `the tokens of the control plane are not valid json: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the tokens of the control plane are not an object of tokens')
  }
  const tokens = new Map<string, ControlIdentity>()
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (token.length < MINIMUM_TOKEN_LENGTH) {
      throw new Error(
        `a token of the control plane is shorter than ${MINIMUM_TOKEN_LENGTH} characters`
      )
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`the token "${token}" of the control plane has no identity`)
    }
    const { operator, scope } = value as { operator?: unknown; scope?: unknown }
    if (typeof operator !== 'string' || operator.length === 0) {
      throw new Error(`the token "${token}" of the control plane names no operator`)
    }
    if (typeof scope !== 'string' || !CONTROL_SCOPES.includes(scope as ControlScope)) {
      throw new Error(
        `the token "${token}" of the control plane has the scope "${String(
          scope
        )}", which is not one of ${CONTROL_SCOPES.join(', ')}`
      )
    }
    tokens.set(token, { operator, scope: scope as ControlScope })
  }
  if (tokens.size === 0) {
    throw new Error('the control plane has no token')
  }
  return tokens
}

/**
 * Compares a token with the ones the control plane accepts.
 *
 * The comparison does not stop at the first difference: the time it takes
 * must not tell an attacker which prefix of a token was right.
 */
export function findControlIdentity(
  tokens: ControlTokens,
  presented: string | undefined | null
): ControlIdentity | null {
  if (typeof presented !== 'string' || presented.length === 0) return null
  for (const [token, identity] of tokens) {
    if (sameToken(token, presented)) return identity
  }
  return null
}

/** Compares two tokens without leaking the position of the first difference. */
function sameToken(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

/** Reports whether a scope may do something. */
export function scopeAllows(scope: ControlScope, capability: ControlCapability): boolean {
  return SCOPE_CAPABILITIES[scope].includes(capability)
}

/**
 * The routes a write may not touch.
 *
 * A protected route is a route the deployment cannot afford to lose: a
 * write that removes one of them, or that changes one of them, is refused.
 */
export function parseProtectedRoutes(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * The protected routes a write removes or changes.
 *
 * The comparison is by the route id: a route that is gone, or that is not
 * the same route any more, is a change the deployment did not ask for.
 */
export function protectedRoutesViolations(
  protectedRoutes: readonly string[],
  currentRoutes: readonly { id: string; definition: string }[],
  nextRoutes: readonly { id: string; definition: string }[]
): string[] {
  if (protectedRoutes.length === 0) return []
  const current = new Map(currentRoutes.map((route) => [route.id, route.definition]))
  const next = new Map(nextRoutes.map((route) => [route.id, route.definition]))
  const violations: string[] = []
  for (const id of protectedRoutes) {
    const before = current.get(id)
    const after = next.get(id)
    // A route that is not there yet is added, not changed: the first write
    // of a table cannot remove a route that was never there.
    if (before === undefined) continue
    if (before !== after) violations.push(id)
  }
  return violations.sort()
}
