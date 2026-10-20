import type { RouteTimeouts, Timeouts } from '../config/schema'
import { normalizePrefix } from './redirect'

/** Joins an upstream base URL with the incoming request path and query. */
export function buildUpstreamUrl(upstream: string, path: string, search: string): string {
  const base = new URL(upstream)
  const basePath = base.pathname.replace(/\/+$/, '')
  const requestPath = path.startsWith('/') ? path : `/${path}`
  base.pathname = `${basePath}${requestPath}` || '/'
  base.search = search
  base.hash = ''
  return base.toString()
}

/** Builds the WebSocket URL for an upstream (http -> ws, https -> wss). */
export function buildWebsocketUrl(upstream: string, path: string, search: string): string {
  const url = new URL(buildUpstreamUrl(upstream, path, search))
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

/**
 * The origin of an upstream, without its path.
 *
 * A redirect of the upstream that points at this origin is the upstream
 * talking about itself.
 */
export function upstreamOriginOf(upstream: string): string {
  try {
    return new URL(upstream).origin
  } catch {
    return ''
  }
}

/**
 * The prefix an upstream application is mounted under.
 *
 * The request path is forwarded unchanged, so the application is mounted
 * under the path of the upstream plus the part of the route template the
 * request matched. A redirect of the application has to carry that prefix,
 * otherwise it leaves the application.
 */
export function mountPrefixOf(upstream: string, routePrefix: string): string {
  let base = ''
  try {
    base = new URL(upstream).pathname.replace(/\/+$/, '')
  } catch {
    base = ''
  }
  const prefix = routePrefix ? `${base}${routePrefix}` : base
  return normalizePrefix(prefix)
}

/**
 * Merges the budgets of a route with the budgets of the configuration.
 *
 * The merge happens field by field: a route that only sets `connectMs`
 * keeps the header and the body budget of the configuration.
 */
export function resolveTimeouts(configured: Timeouts, overrides?: RouteTimeouts): Timeouts {
  return {
    connectMs: overrides?.connectMs ?? configured.connectMs,
    headersMs: overrides?.headersMs ?? configured.headersMs,
    bodyMs: overrides?.bodyMs ?? configured.bodyMs,
  }
}
