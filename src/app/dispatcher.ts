/**
 * The dispatcher of the gateway.
 *
 * For every request that is not one of the endpoints of the gateway itself,
 * the dispatcher runs the pipeline of the specification:
 *
 * 1. the configuration is captured
 * 2. a path that is reserved is refused
 * 3. the forwarding context is computed
 * 4. the route is matched, **before** the limiters
 * 5. the global limit and the limit of the route are applied
 * 6. a request that matched no route is refused
 * 7. the caller is authenticated
 * 8. the cross site guard is applied to the requests that carry the cookie
 *    of the session
 * 9. the access service is asked about the workspace
 * 10. the request is dispatched
 */

import type { Context } from 'hono'
import {
  GATEWAY_COOKIE_NAMES,
  SESSION_COOKIE_NAME,
  selectCredential,
  serializeCookie,
  type Principal,
} from '../domains/authentication'
import { isReservedPath } from '../domains/configuration'
import {
  buildClientHeaders,
  buildUpstreamHeaders,
  buildUpstreamTarget,
  buildWebsocketUpstreamHeaders,
  checkCrossSite,
  resolveForwardingContext,
  rewriteLocation,
  signIdentity,
  upstreamOrigin,
  writtenIdentity,
  type CallerIdentity,
} from '../domains/forwarding'
import { TOTAL_RATE_LIMIT_KEY, rateLimitKey } from '../domains/rate-limiting'
import { matchRoute } from '../domains/routing'
import type { ExchangeFailure } from '../domains/proxying'
import { validateWorkspace } from '../domains/workspace-access'
import { UNMATCHED_ROUTE, redactUrl } from '../observability'
import type { GatewayDependencies } from './dependencies'
import { readCookie } from './cookies'
import { clientGoneResponse, jsonError } from './errors'
import { buildRevalidation } from './revalidation'
import type { GatewayEnv } from './state'

/** Reports whether a request wants to be upgraded to a websocket. */
function isUpgradeRequest(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
}

/** Reports whether the caller wants an html answer. */
function wantsHtml(context: Context<GatewayEnv>): boolean {
  return (context.req.header('accept') ?? '').includes('text/html')
}

/**
 * Records a request the gateway answered itself.
 *
 * The request is recorded with the route it was matched on, or with
 * `unmatched` when it matched no route. The bytes are zero: a request the
 * gateway answered itself never reached an upstream.
 */
function recordOutcome(
  dependencies: GatewayDependencies,
  routeId: string,
  method: string,
  status: number,
  started: number
): void {
  dependencies.observer.recordRequest({
    routeId,
    method,
    status,
    durationMs: Date.now() - started,
    bytesIn: 0,
    bytesOut: 0,
  })
}

/**
 * Runs the pipeline of a request that is not an endpoint of the gateway.
 */
export async function dispatch(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies,
  requestId: string,
  started: number
): Promise<Response> {
  const { logger, observer } = dependencies

  // 1. The configuration. A gateway that never loaded a configuration has
  // no routes to offer.
  const snapshot = dependencies.config.snapshot
  if (!snapshot) {
    recordOutcome(dependencies, UNMATCHED_ROUTE, context.req.method, 503, started)
    return jsonError(503, 'not_ready', 'the gateway has no valid configuration')
  }

  const url = new URL(context.req.url)
  const path = url.pathname
  const method = context.req.method

  // 2. The paths the gateway serves itself are reserved, whatever the
  // configuration says: a route must not be able to shadow them.
  if (isReservedPath(snapshot, path)) {
    recordOutcome(dependencies, UNMATCHED_ROUTE, method, 404, started)
    return jsonError(404, 'not_found', 'unknown reserved path')
  }

  // 3. The peer address is the basis of the trusted proxy evaluation, and
  // the client address is the key of the limiters.
  const forwarding = resolveForwardingContext({
    peerAddress: dependencies.peerAddress(context.req.raw),
    headers: context.req.raw.headers,
    trustedProxies: snapshot.trustedProxies,
    externalProto: dependencies.externalProto,
  })
  context.set('forwarding', forwarding)

  // The host the caller used: the one the trusted proxy reports, when the
  // peer is a trusted proxy. It is the host the route is matched on, the
  // host the browser is compared with and the host the signature covers.
  const host = forwarding.host

  // 4. The route is matched before the limiters, so the budget of a route
  // is spent by the requests that the route would handle.
  const match = matchRoute(snapshot.routes, host, path)
  const route = match?.route.payload
  if (route) context.set('routeId', route.id)

  // 5. The limits: the budget of the deployment, the budget of the caller
  // over all the routes and the budget of the caller on this route. The
  // requests that match no route are counted in a bucket of their own.
  const total = await dependencies.totalRateLimiter.check(TOTAL_RATE_LIMIT_KEY)
  const global = await dependencies.globalRateLimiter.check(
    rateLimitKey('global', { clientIp: forwarding.clientIp })
  )
  const scoped = await dependencies.rateLimiter.check(
    route
      ? rateLimitKey('route', { clientIp: forwarding.clientIp, routeId: route.id })
      : rateLimitKey('unmatched', { clientIp: forwarding.clientIp })
  )
  const limit = !total.allowed ? total : !global.allowed ? global : scoped
  if (!limit.allowed) {
    logger.warn('the request rate limit was reached', {
      requestId,
      client: forwarding.clientIp,
      routeId: route?.id ?? null,
    })
    observer.recordRateLimit()
    recordOutcome(dependencies, route?.id ?? UNMATCHED_ROUTE, method, 429, started)
    return new Response(
      JSON.stringify({ error: 'too_many_requests', message: 'too many requests' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
        },
      }
    )
  }

  // 6. A request that matched no route is refused. It has been counted by
  // the limiters already: a flood of requests to a path that does not
  // exist is a flood like any other.
  if (!match || !route) {
    recordOutcome(dependencies, UNMATCHED_ROUTE, method, 404, started)
    return jsonError(404, 'no_route', 'no route matches this request')
  }

  // 7. The authentication. The mode of the route decides which credentials
  // are accepted and the order in which they are evaluated is fixed.
  const sessionCookie = context.req.header('cookie')
    ? readCookie(context.req.header('cookie'), SESSION_COOKIE_NAME)
    : undefined
  const plan = selectCredential(route.auth.mode, {
    authorization: context.req.header('authorization'),
    sessionCookie,
  })
  let principal: Principal | null = null
  if (route.auth.mode !== 'none') {
    const outcome = await dependencies.auth.authenticate(plan)
    principal = outcome?.principal ?? null
    if (!principal) {
      observer.recordAuthFailure(route.id, 'unauthenticated')
      if (wantsHtml(context) && route.auth.mode !== 'jwt') {
        const target = encodeURIComponent(path + url.search)
        recordOutcome(dependencies, route.id, method, 302, started)
        return new Response(null, {
          status: 302,
          headers: { location: `/auth/login?redirect=${target}` },
        })
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (route.auth.mode === 'jwt' || route.auth.mode === 'any') {
        headers['www-authenticate'] = 'Bearer realm="shuttle"'
      }
      recordOutcome(dependencies, route.id, method, 401, started)
      return new Response(
        JSON.stringify({ error: 'unauthorized', message: 'authentication is required' }),
        { status: 401, headers }
      )
    }
    if (outcome?.session) {
      // The cookie follows the session: the browser learns about the new
      // lifetime of the session, also when the request is refused.
      context.set('cookies', [...context.get('cookies'), outcome.session.cookie])
    }
    // The budget of the authenticated caller on this route. It is keyed by
    // the subject of the caller, so a tenant behind an address that serves
    // many users cannot spend the budget of the others.
    const principalLimit = await dependencies.principalRateLimiter.check(
      rateLimitKey('principal', { routeId: route.id, subject: principal.subject })
    )
    if (!principalLimit.allowed) {
      logger.warn('the principal rate limit was reached', {
        requestId,
        routeId: route.id,
        subject: principal.subject,
      })
      observer.recordRateLimit()
      recordOutcome(dependencies, route.id, method, 429, started)
      return new Response(
        JSON.stringify({ error: 'too_many_requests', message: 'too many requests' }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(Math.max(1, Math.ceil(principalLimit.retryAfterMs / 1000))),
          },
        }
      )
    }
  }

  // 8. The cross site guard. It is driven by the **presence** of the
  // cookie of the session: a browser attaches the cookie on its own, so a
  // request that carries it is a request of a browser, even when a bearer
  // token is the credential that authenticated it.
  //
  // A route may refuse the navigations from another site as well: a route
  // whose upstream changes the state of something on a `GET` may only be
  // reached from the site itself.
  if (sessionCookie) {
    const crossSite = checkCrossSite({
      method,
      headers: context.req.raw.headers,
      host,
      externalProto: forwarding.proto,
      allowedOrigins: dependencies.browser.allowedOrigins,
      strict: dependencies.browser.csrfStrict || route.crossSite === 'strict',
    })
    if (!crossSite.allowed) {
      logger.warn('a cross site request was refused', {
        requestId,
        routeId: route.id,
        reason: crossSite.reason,
      })
      observer.recordCrossSiteRefusal(route.id)
      recordOutcome(dependencies, route.id, method, 403, started)
      return jsonError(403, 'cross_site_request', crossSite.reason ?? 'the request was refused')
    }
  }

  // 9. The workspace. The access service decides, the gateway asks and
  // fails closed.
  let workspaceId: string | undefined
  if (route.auth.workspace) {
    const raw = match.params[route.auth.workspace.param]
    const validation = validateWorkspace(raw, {
      requireUuid: route.auth.workspace.requireUuid,
    })
    if (!validation.ok) {
      recordOutcome(dependencies, route.id, method, 400, started)
      return jsonError(
        400,
        'bad_request',
        validation.reason === 'missing'
          ? 'the workspace identifier is missing from the request path'
          : 'the workspace identifier is not a valid UUID'
      )
    }
    workspaceId = validation.workspaceId
    if (principal) {
      const decision = await dependencies.access.decide(
        {
          subject: principal.subject,
          workspaceId,
          routeId: route.id,
          roles: principal.roles,
        },
        // The lifetime of the cached decision is the latency of a
        // revocation on this route: a route that asks for zero asks the
        // access service for every request.
        { cacheTtlMs: route.accessCacheTtlMs }
      )
      if (!decision.allow) {
        observer.recordAuthFailure(route.id, failureReasonOf(decision.reason))
        logger.warn('workspace access denied', {
          requestId,
          routeId: route.id,
          workspaceId,
          reason: decision.reason,
        })
        // The reason of the access service is not given to the caller: it
        // describes the policy of the platform and it is not the business
        // of the client.
        recordOutcome(dependencies, route.id, method, 403, started)
        return jsonError(
          403,
          'workspace_forbidden',
          'the workspace is not available to this caller',
          { workspaceId }
        )
      }
    }
  }

  // 10. The dispatch.
  if (isUpgradeRequest(context.req.raw)) {
    if (!route.websocket) {
      recordOutcome(dependencies, route.id, method, 400, started)
      return jsonError(
        400,
        'websocket_not_allowed',
        'this route does not accept websocket connections'
      )
    }
    if (!dependencies.websockets) {
      recordOutcome(dependencies, route.id, method, 503, started)
      return jsonError(503, 'websocket_unavailable', 'the websockets are not available')
    }
    const identity = principal ? writtenIdentity(identityOf(principal, workspaceId)) : undefined
    const target = buildUpstreamTarget(route.upstream, path, url.search)
    const targetUrl = new URL(target)
    const upgrade = context.env.upgrade
    if (!upgrade) {
      recordOutcome(dependencies, route.id, method, 503, started)
      return jsonError(503, 'websocket_unavailable', 'the websockets are not available')
    }
    // The handshake with the upstream follows the same header policy as the
    // requests of the http path: the cookies of the gateway never reach an
    // upstream and the identity is written by the gateway.
    const upstreamHeaders = buildWebsocketUpstreamHeaders({
      incoming: context.req.raw.headers,
      forwarding,
      identity,
      signature: identity
        ? signIdentity(
            identity,
            {
              method,
              path: targetUrl.pathname,
              query: targetUrl.search,
              host: forwarding.host,
            },
            dependencies.identityKey
          )
        : undefined,
      gatewayCookies: dependencies.gatewayCookies,
      forwardAuthorization: route.forwardAuthorization,
    })
    const outcome = await dependencies.websockets.handle(
      context.req.raw,
      {
        routeId: route.id,
        upstream: route.upstream,
        path,
        search: url.search,
        method,
        headers: context.req.raw.headers,
        upstreamHeaders,
        requestId,
        cookies: context.get('cookies').map((cookie) => serializeCookie(cookie)),
        carriesSessionCookie: sessionCookie !== undefined,
        host: forwarding.host,
        externalProto: forwarding.proto,
        allowedOrigins: dependencies.browser.allowedOrigins,
        // The connection is revalidated while it is open: a session that
        // expired, an access that was revoked and a route that changed all
        // have to end a connection that was opened under the old rules.
        revalidate: buildRevalidation(dependencies, {
          routeId: route.id,
          subject: principal?.subject,
          roles: principal?.roles,
          workspaceId,
          sessionId: plan.kind === 'session' ? plan.sessionId : undefined,
        }),
      },
      upgrade
    )
    if (outcome.kind === 'upgraded') {
      // The answer of the upgrade was already sent by the runtime.
      recordOutcome(dependencies, route.id, method, 101, started)
      return new Response(null)
    }
    recordOutcome(dependencies, route.id, method, outcome.status, started)
    return jsonError(outcome.status, outcome.code, outcome.message)
  }

  // The http path.
  const target = buildUpstreamTarget(route.upstream, path, url.search)
  const targetUrl = new URL(target)
  const identity = principal ? writtenIdentity(identityOf(principal, workspaceId)) : undefined
  const headers = buildUpstreamHeaders({
    incoming: context.req.raw.headers,
    forwarding,
    identity,
    signature: identity
      ? signIdentity(
          identity,
          {
            method,
            path: targetUrl.pathname,
            query: targetUrl.search,
            host: forwarding.host,
          },
          dependencies.identityKey
        )
      : undefined,
    gatewayCookies: dependencies.gatewayCookies,
    forwardAuthorization: route.forwardAuthorization,
  })

  const result = await dependencies.exchanges.execute({
    method,
    url: target,
    headers,
    body: context.req.raw.body,
    signal: context.req.raw.signal,
    timeouts: route.timeouts,
    maxBodyBytes: route.maxBodyBytes,
    onFinalize: (finalized) => {
      // The metrics of a request are written when the exchange is over: the
      // duration of a request is the time the caller waited and the bytes
      // are the bytes that really went through.
      const status = finalized.status ?? statusOfFailure(finalized.failure)
      dependencies.observer.recordRequest({
        routeId: route.id,
        method,
        status,
        durationMs: Date.now() - started,
        bytesIn: finalized.bytesIn,
        bytesOut: finalized.bytesOut,
      })
      if (finalized.status === undefined) return
      logger.info('request proxied', {
        requestId,
        routeId: route.id,
        method,
        path: redactUrl(`${path}${url.search}`),
        status: finalized.status,
        durationMs: Date.now() - started,
        bytesIn: finalized.bytesIn,
        bytesOut: finalized.bytesOut,
        outcome: finalized.outcome,
      })
    },
  })

  if (!result.response) {
    const failure = result.failure
    const status = statusOfFailure(failure)
    logger.warn('the upstream request failed', {
      requestId,
      routeId: route.id,
      kind: failure?.kind ?? 'unknown',
      error: failure?.message,
    })
    if (status === 499) return clientGoneResponse()
    if (status === 413) {
      return jsonError(
        413,
        'payload_too_large',
        failure?.message ?? 'the request body is too large'
      )
    }
    if (status === 504) {
      return jsonError(
        504,
        'gateway_timeout',
        failure?.message ?? 'the upstream did not answer in time'
      )
    }
    if (status === 503) {
      return jsonError(
        503,
        'gateway_overloaded',
        failure?.message ?? 'the gateway is handling too many requests'
      )
    }
    // The message of a network error names the internal host and the port
    // of the upstream, so it is not given to the caller: it is in the log.
    return jsonError(502, 'bad_gateway', 'the upstream could not be reached')
  }

  // The answer of the upstream is forwarded with the headers of the
  // gateway: the upstream is a different trust domain.
  const responseHeaders = buildClientHeaders(result.response.headers, dependencies.gatewayCookies)
  responseHeaders.set('x-request-id', requestId)

  // A location that names the upstream itself is made relative: the
  // internal hostname of the upstream never reaches the browser. A location
  // that names another host is left alone.
  const location = responseHeaders.get('location')
  if (location) {
    const rewritten = rewriteLocation(location, { upstreamOrigin: upstreamOrigin(route.upstream) })
    if (rewritten !== location) responseHeaders.set('location', rewritten)
  }

  return new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers: responseHeaders,
  })
}

/** The status of a failure of an exchange. */
function statusOfFailure(failure: ExchangeFailure | null): number {
  switch (failure?.kind) {
    case 'too_large':
      return 413
    case 'timeout':
      return 504
    case 'aborted':
      return 499
    case 'overloaded':
      return 503
    default:
      return 502
  }
}

/** The identity of the caller, as the forwarding domain wants it. */
function identityOf(principal: Principal, workspaceId: string | undefined): CallerIdentity {
  return {
    subject: principal.subject,
    email: principal.email,
    roles: principal.roles,
    workspaceId,
  }
}

/** The reason of a denial, as the metric counts it. */
function failureReasonOf(reason: string): 'missing_role' | 'access_denied' {
  return /role/i.test(reason) ? 'missing_role' : 'access_denied'
}

export { GATEWAY_COOKIE_NAMES, UNMATCHED_ROUTE }
