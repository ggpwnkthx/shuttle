/**
 * The endpoints of the gateway.
 *
 * They are the paths the gateway serves itself. They are matched before the
 * route table is consulted and they are never forwarded to an upstream,
 * whatever the configuration says.
 */

import type { Context } from 'hono'
import { SessionStoreError } from '../domains/authentication'
import { checkCrossSiteNavigation } from '../domains/forwarding'
import { rateLimitKey } from '../domains/rate-limiting'
import { readCookie } from './cookies'
import type { GatewayDependencies } from './dependencies'
import { jsonError } from './errors'
import type { GatewayEnv } from './state'

/**
 * The health of the gateway.
 *
 * It is always available: it says that the process answers, not that the
 * gateway can serve the traffic.
 */
export function healthHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Response {
  return context.json({
    status: 'ok',
    service: 'shuttle',
    version: dependencies.version,
    uptimeMs: Date.now() - context.get('startedAt'),
  })
}

/**
 * The readiness of the gateway.
 *
 * The gateway is ready when a configuration is loaded and the session store
 * answers: a task that cannot reach the store would reject every
 * authenticated request.
 */
export async function readyHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Promise<Response> {
  const status = dependencies.config.status()
  const sessionStore = await dependencies.auth.sessions.ping()
  // A gateway that is draining does not accept new work: the readiness
  // probe takes it out of the rotation.
  const draining = dependencies.isDraining?.() ?? false
  const ready = status.loaded && sessionStore && !draining
  return context.json(
    {
      status: ready ? 'ready' : draining ? 'draining' : 'not-ready',
      config: status,
      sessionStore: sessionStore ? 'ok' : 'unavailable',
    },
    ready ? 200 : 503
  )
}

/**
 * The metrics of the gateway.
 *
 * The endpoint is only served when a token is configured, so the metrics
 * never end up on a public listener by accident.
 */
export async function metricsHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Promise<Response> {
  const token = dependencies.metricsToken
  if (!token) {
    return jsonError(404, 'not_found', 'unknown reserved path')
  }
  const header = context.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match || !sameToken(match[1]!.trim(), token)) {
    return jsonError(401, 'unauthorized', 'a valid metrics token is required')
  }
  return new Response(await dependencies.observer.render(), {
    headers: { 'content-type': dependencies.observer.contentType },
  })
}

/**
 * The login of a browser.
 *
 * The limiter of the logins is applied here: the handler computes the
 * forwarding context itself, exactly like the dispatcher does, because the
 * address of the caller is the key of the limiter.
 */
export async function loginHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Promise<Response> {
  const forwarding = context.get('forwarding')
  const client = forwarding?.clientIp ?? 'unknown'
  const limit = await dependencies.loginRateLimiter.check(
    rateLimitKey('login', { clientIp: client })
  )
  if (!limit.allowed) {
    dependencies.logger.warn('the login rate limit was reached', { client })
    dependencies.observer.recordRateLimit()
    return new Response(
      JSON.stringify({ error: 'too_many_requests', message: 'too many login attempts' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
        },
      }
    )
  }
  try {
    const begun = await dependencies.auth.beginLogin(context.req.query('redirect') ?? '/')
    context.set('cookies', [...context.get('cookies'), begun.stateCookie])
    return new Response(null, { status: 302, headers: { location: begun.authorizationUrl } })
  } catch (error) {
    dependencies.logger.warn('unable to start the login flow', { error })
    return jsonError(
      503,
      'identity_provider_unavailable',
      'the identity provider cannot be reached at the moment'
    )
  }
}

/**
 * The end of a browser login.
 *
 * The state of the login is single use: the cookie of the state is deleted
 * when the callback is processed, whatever the outcome is.
 */
export async function callbackHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Promise<Response> {
  // The cookie of the state is deleted in every case: a state that was used
  // must not be used again.
  context.set('cookies', [...context.get('cookies'), dependencies.auth.loginStateDeletion()])
  try {
    const result = await dependencies.auth.completeLogin({
      params: new URL(context.req.url).searchParams,
      stateCookie: readCookie(context.req.header('cookie'), 'shuttle_oidc_state'),
    })
    context.set('cookies', [...context.get('cookies'), result.sessionCookie])
    return new Response(null, { status: 302, headers: { location: result.redirect } })
  } catch (error) {
    dependencies.logger.warn('the login failed', { error })
    if (error instanceof SessionStoreError) {
      return jsonError(503, 'session_store_unavailable', 'the session store is not available')
    }
    return jsonError(400, 'login_failed', 'the login could not be completed')
  }
}

/**
 * The logout of a browser.
 *
 * A link on another site must not be able to log a caller out: the request
 * is refused when it comes from another site. The browser sends the cookie
 * of the session on a top level navigation, so the guard needs the headers
 * of the browser, not only the credential of the request.
 */
export async function logoutHandler(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): Promise<Response> {
  const crossSite = checkCrossSiteNavigation({
    method: context.req.method,
    headers: context.req.raw.headers,
    host: context.req.header('host') ?? '',
    externalProto: dependencies.externalProto,
    allowedOrigins: dependencies.browser.allowedOrigins,
    strict: false,
  })
  if (!crossSite.allowed) {
    dependencies.logger.warn('a cross site logout was refused', { reason: crossSite.reason })
    return jsonError(403, 'cross_site_request', crossSite.reason ?? 'the request was refused')
  }
  const deletion = await dependencies.auth.logout(
    readCookie(context.req.header('cookie'), 'shuttle_session')
  )
  context.set('cookies', [...context.get('cookies'), deletion])
  return new Response(null, { status: 302, headers: { location: '/' } })
}

/** Compares two tokens in constant time. */
function sameToken(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
