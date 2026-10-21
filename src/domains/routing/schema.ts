/**
 * The schema of the identity and of the match of a route.
 *
 * The routing domain owns the identity of a route (its id) and the shape of
 * the paths and of the hosts it matches. The policy of a route (its
 * authentication, its budgets, its upstream) belongs to the configuration
 * domain, which composes these schemas.
 */

import { z } from 'zod'

/** The maximum length of a host pattern. */
export const HOST_PATTERN_MAX = 253

/** The maximum length of a path template. */
export const PATH_TEMPLATE_MAX = 512

/** The shape of the id of a route: lowercase kebab-case. */
export const ROUTE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The shape of the name of a placeholder. */
export const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A placeholder of a path template: `{name}`. */
const PLACEHOLDER_PATTERN = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/

/** A literal segment of a path template. */
const LITERAL_SEGMENT_PATTERN = /^[^{}:*]+$/

/** The id of a route. */
export const RouteIdSchema = z
  .string()
  .regex(ROUTE_ID_PATTERN, 'a route id is lowercase kebab-case and at most 63 characters long')

/**
 * The host a route matches.
 *
 * Three shapes are allowed: an exact host (`api.example.com`), a wildcard
 * (`*.example.com`, which matches the subdomains but not the domain
 * itself) and the catch-all (`*`).
 */
export const HostPatternSchema = z
  .string()
  .min(1)
  .max(HOST_PATTERN_MAX)
  .refine(isValidHostPattern, {
    message:
      'a host is "example.com", "*.example.com" or "*"; a wildcard matches the subdomains but not the domain itself',
  })

/** The path a route matches. */
export const PathTemplateSchema = z
  .string()
  .startsWith('/', 'a path template starts with a slash')
  .max(PATH_TEMPLATE_MAX)
  .refine(isValidPathTemplate, {
    message:
      'a path template is a list of segments; a segment is a literal or a {placeholder}, a literal must not contain "{", "}", ":" or "*"',
  })

/**
 * The shape of the name of a method.
 *
 * A method is a token of RFC 9110: the characters of a token and nothing
 * else. A name that carries something else would never match the method of
 * a request, so it is refused when the configuration is loaded.
 */
export const METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * The methods a route accepts.
 *
 * The list is upper cased, so a route may be written with the methods in
 * the case the reader prefers. A route that names no method accepts every
 * method.
 */
export const MethodsSchema = z
  .array(z.string().min(1).max(32).regex(METHOD_PATTERN, 'a method is a token of HTTP'))
  .min(1)
  .optional()
  .transform((methods) =>
    methods === undefined ? undefined : [...new Set(methods.map((method) => method.toUpperCase()))]
  )

/**
 * The path a route forwards to its upstream.
 *
 * It is a list of segments like a path template, and it may carry the
 * placeholder `{rest}`: the part of the path that follows the prefix the
 * route matched.
 */
export const RewriteTemplateSchema = z
  .string()
  .min(1)
  .max(PATH_TEMPLATE_MAX)
  .refine(isValidRewriteTemplate, {
    message:
      'a rewrite is a list of segments; a segment is a literal or a {placeholder}, "{rest}" is the part of the path that follows the prefix the route matched and it may only be the last segment',
  })

/**
 * Reports whether a host pattern has a shape the gateway can match.
 *
 * A host is a name, a wildcard or the catch-all. A host that carries a port
 * or a path is not a host: the port of the `Host` header is stripped before
 * the comparison, and a path in the pattern would never match.
 */
export function isValidHostPattern(value: string): boolean {
  const pattern = value.trim().toLowerCase()
  if (pattern === '*') return true
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern
  if (host === '' || host.includes('/') || host.includes(':')) return false
  if (host.includes('*')) return false
  // A host is a name or an address; the labels of a name are separated by
  // dots and a label is not empty.
  if (host.includes('..')) return false
  return host.split('.').every((label) => label.length > 0)
}

/**
 * Reports whether a path template has a shape the gateway can match.
 *
 * A template is a list of segments separated by `/`. A segment is either a
 * literal or a `{placeholder}`; a literal must not contain a character that
 * the path matcher would read as a placeholder (`{`, `}`, `:`) or as a
 * wildcard (`*`).
 */
export function isValidPathTemplate(value: string): boolean {
  const segments = value.split('/').filter((segment) => segment !== '')
  return segments.every(
    (segment) => LITERAL_SEGMENT_PATTERN.test(segment) || PLACEHOLDER_PATTERN.test(segment)
  )
}

/**
 * The placeholder that stands for the rest of the path.
 *
 * It is the part of the path that follows the prefix the route matched,
 * and it may only be the last segment of a rewrite.
 */
export const REST_PLACEHOLDER = 'rest'

/**
 * Reports whether a rewrite template has a shape the gateway can use.
 *
 * A rewrite is a list of segments separated by `/`. A segment is either a
 * literal or a `{placeholder}`; the placeholder `{rest}` stands for the
 * part of the path that follows the prefix the route matched, and it may
 * only be the last segment.
 */
export function isValidRewriteTemplate(value: string): boolean {
  if (!value.startsWith('/')) return false
  const segments = value.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return false
  let seenRest = false
  for (const [index, segment] of segments.entries()) {
    if (seenRest) return false
    if (segment === `{${REST_PLACEHOLDER}}`) {
      seenRest = true
      continue
    }
    if (!LITERAL_SEGMENT_PATTERN.test(segment) && !PLACEHOLDER_PATTERN.test(segment)) {
      return false
    }
    if (index === segments.length - 1 && segment === `{${REST_PLACEHOLDER}}`) continue
  }
  return true
}

/** The kind of a host pattern. */
export type HostKind = 'exact' | 'wildcard' | 'any'

/** A host pattern, split into its kind and its value. */
export interface HostPattern {
  kind: HostKind
  /**
   * The value of the pattern, lower cased.
   *
   * It is the host itself for an exact pattern and the suffix for a
   * wildcard (`*.example.com` carries `example.com`).
   */
  value: string
}

/** Splits a host pattern into its kind and its value. */
export function parseHostPattern(pattern: string): HostPattern {
  const value = pattern.trim().toLowerCase()
  if (value === '*') return { kind: 'any', value: '' }
  if (value.startsWith('*.')) return { kind: 'wildcard', value: value.slice(2) }
  return { kind: 'exact', value }
}

/**
 * Strips the port and the trailing dot of the host of a request.
 *
 * The `Host` header of a request carries the port the client used and it
 * may carry a trailing dot (`api.example.com.`). Both are not part of the
 * name of the host and both are stripped before the comparison.
 */
export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    // An address of ipv6 is written between brackets, with the port after
    // the closing bracket.
    const end = value.indexOf(']')
    if (end !== -1) value = value.slice(1, end)
    return value
  }
  const colon = value.indexOf(':')
  if (colon !== -1) value = value.slice(0, colon)
  if (value.endsWith('.')) value = value.slice(0, -1)
  return value
}
