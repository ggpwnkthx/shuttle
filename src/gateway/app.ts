import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import type { WebSocket as UpstreamWebSocket } from 'ws'
import { timingSafeEqualString } from '../auth/crypto'
import { authFailureReason } from '../auth/access'
import { signIdentity } from '../auth/identity'
import { SessionStoreError } from '../auth/session'
import type { Principal } from '../auth/service'
import { isReservedPath, isUuid, type RouteConfig } from '../config/schema'
import { matchRoute } from '../config/matcher'
import { redactUrl } from '../log/logger'
import type { Runtime } from '../runtime/runtime'
import { buildUpstreamHeaders, resolveForwarding } from './headers'
import { checkCrossSite, checkCrossSiteNavigation } from './csrf'
import { forwardRequest } from './proxy'
import { rewriteLocation } from './redirect'
import { buildUpstreamUrl, buildWebsocketUrl, mountPrefixOf, resolveTimeouts, upstreamOriginOf } from './upstream'
import {
  connectUpstream,
  HANDSHAKE_HEADERS,
  offeredProtocols,
  WebSocketRegistry,
  type WebSocketContext,
} from './websocket'

export type GatewayEnv = {
  Bindings: Bun.Server<unknown>
  Variables: { requestId: string }
}

export interface GatewayDependencies {
  /**
   * The registry of the websocket connections.
   *
   * It is shared with the websocket handler, so the gateway knows how many
   * connections are open before it accepts another one.
   */
  websockets?: WebSocketRegistry
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function resolveRequestId(c: Context): string {
  const incoming = c.req.header('x-request-id')
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming
  return randomUUID()
}

function wantsHtml(c: Context): boolean {
  const accept = c.req.header('accept') ?? ''
  return accept.includes('text/html')
}

function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function createGatewayApp(
  runtime: Runtime,
  dependencies: GatewayDependencies = {}
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>()
  const logger = runtime.logger
  const websockets =
    dependencies.websockets ??
    new WebSocketRegistry(runtime.options.websocketMaxConnections)

  /**
   * The address of the caller, as the trusted proxies report it.
   *
   * It is the key of the limiters: a caller behind a proxy is counted once,
   * not once per proxy.
   */
  const clientAddress = (c: Context<GatewayEnv>): string => {
    const state = runtime.config.loaded ? runtime.config.state : null
    const peerAddress = c.env?.requestIP?.(c.req.raw)?.address ?? '0.0.0.0'
    const forwarding = resolveForwarding({
      peerAddress,
      incoming: c.req.raw.headers,
      trustedProxies: [
        ...(state?.config.trustedProxies ?? []),
        ...runtime.options.trustedProxies,
      ],
      tls: runtime.options.externalProto === 'https',
    })
    return forwarding.clientIp
  }

  /**
   * The signature of the identity the gateway writes into the headers.
   *
   * An upstream that wants to be sure that the request went through the
   * gateway verifies it with the shared secret.
   */
  const identitySignature = (
    principal: Principal,
    workspaceId: string | undefined,
    method: string,
    path: string,
    query: string,
    host: string
  ): string =>
    signIdentity(
      {
        subject: principal.subject,
        email: principal.email,
        roles: principal.roles,
        workspaceId,
      },
      { method, path, query, host },
      runtime.identityKey
    )

  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c)
    c.set('requestId', requestId)
    await next()
    try {
      c.res.headers.set('x-request-id', requestId)
    } catch {
      /* the response headers are immutable, nothing we can do */
    }
  })

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', service: 'shuttle', uptimeMs: Date.now() - runtime.startedAt })
  )

  app.get('/readyz', async (c) => {
    const status = runtime.config.status()
    // The session store is shared by every replica: a task that cannot reach
    // it would reject every authenticated request.
    const sessionStore = await runtime.sessions.ping()
    const ready = status.loaded && sessionStore
    return c.json(
      {
        status: ready ? 'ready' : 'not-ready',
        config: status,
        sessionStore: sessionStore ? 'ok' : 'unavailable',
      },
      ready ? 200 : 503
    )
  })

  /**
   * The metrics of the gateway, in the Prometheus text exposition format.
   *
   * The endpoint is only served when a token is configured, so the metrics
   * never end up on a public listener by accident.
   */
  app.get('/metrics', async (c) => {
    const token = runtime.options.metricsToken
    if (!token) {
      return jsonError(404, 'not_found', 'unknown reserved path')
    }
    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match || !timingSafeEqualString(match[1]!.trim(), token)) {
      return jsonError(401, 'unauthorized', 'a valid metrics token is required')
    }
    return new Response(await runtime.metrics.render(), {
      headers: { 'content-type': runtime.metrics.contentType },
    })
  })

  app.get('/auth/login', async (c) => {
    const client = clientAddress(c)
    const limit = await runtime.loginRateLimiter.check(client)
    if (!limit.allowed) {
      logger.warn('the login rate limit was reached', { client })
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
      return await runtime.auth.beginLogin(c, c.req.query('redirect') ?? '/')
    } catch (error) {
      logger.warn('unable to start the login flow', { error })
      return jsonError(503, 'identity_provider_unavailable', 'the identity provider cannot be reached at the moment')
    }
  })

  app.get('/auth/callback', async (c) => {
    try {
      const result = await runtime.auth.completeLogin(c, {
        code: c.req.query('code'),
        state: c.req.query('state'),
        error: c.req.query('error'),
      })
      return c.redirect(result.redirect, 302)
    } catch (error) {
      logger.warn('login failed', { error })
      if (error instanceof SessionStoreError) {
        return jsonError(503, 'session_store_unavailable', 'the session store is not available')
      }
      return jsonError(400, 'login_failed', 'the login could not be completed')
    }
  })

  app.get('/auth/logout', async (c) => {
    // A link on another site must not be able to log a caller out: the
    // request is refused when it comes from another site. The browser sends
    // the session cookie on a top level navigation, so the guard needs the
    // headers of the browser, not only the credential of the request.
    const crossSite = checkCrossSiteNavigation({
      method: 'GET',
      headers: c.req.raw.headers,
      host: c.req.header('host') ?? '',
      externalProto: runtime.options.externalProto,
      allowedOrigins: runtime.options.allowedOrigins,
      strict: false,
    })
    if (!crossSite.allowed) {
      logger.warn('a cross site logout was refused', { reason: crossSite.reason })
      return jsonError(403, 'cross_site_request', crossSite.reason ?? 'the request was refused')
    }
    await runtime.auth.logout(c)
    return c.redirect('/', 302)
  })

  const dispatch = async (c: Context<GatewayEnv>, requestId: string, started: number): Promise<Response> => {
    const state = runtime.config.loaded ? runtime.config.state : null
    if (!state) {
      return jsonError(503, 'not_ready', 'the gateway has no valid configuration')
    }

    const url = new URL(c.req.url)
    const path = url.pathname
    const method = c.req.method
    const host = c.req.header('host') ?? ''

    // The paths the gateway serves itself are reserved, whatever the
    // configuration says. A route must not be able to shadow them: the
    // metrics endpoint and the login flow are part of the security
    // invariant of the gateway, not a path an operator may hand to an
    // upstream.
    if (isReservedPath(state.config, path)) {
      return jsonError(404, 'not_found', 'unknown reserved path')
    }

    // The peer address is the basis of the trusted proxy evaluation, and the
    // client address is the key of the rate limiter.
    const peerAddress = c.env?.requestIP?.(c.req.raw)?.address ?? '0.0.0.0'
    const forwarding = resolveForwarding({
      peerAddress,
      incoming: c.req.raw.headers,
      trustedProxies: [...state.config.trustedProxies, ...runtime.options.trustedProxies],
      tls: runtime.options.externalProto === 'https',
    })

    const limit = await runtime.rateLimiter.check(forwarding.clientIp)
    if (!limit.allowed) {
      logger.warn('the request rate limit was reached', {
        requestId,
        client: forwarding.clientIp,
        routeId: null,
      })
      runtime.metrics.recordRateLimit(forwarding.clientIp)
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

    const match = matchRoute(state.routes, host, path)
    if (!match) {
      return jsonError(404, 'no_route', 'no route matches this request')
    }
    const route: RouteConfig = match.route.route

    // ---------------------------------------------------------------- auth
    //
    // The mode of the route decides which credentials are accepted, the
    // order in which they are evaluated is fixed. Shuttle never checks
    // roles itself: the access service decides who may use a workspace.
    let principal: Principal | null = null
    if (route.auth.mode !== 'none') {
      principal = await runtime.auth.authenticate(c, route.auth.mode)
      if (!principal) {
        runtime.metrics.recordAuthFailure(route.id, 'unauthenticated')
        if (wantsHtml(c) && route.auth.mode !== 'jwt') {
          const target = encodeURIComponent(path + url.search)
          return new Response(null, {
            status: 302,
            headers: { location: `/auth/login?redirect=${target}` },
          })
        }
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (route.auth.mode === 'jwt' || route.auth.mode === 'any') {
          headers['www-authenticate'] = 'Bearer realm="shuttle"'
        }
        return new Response(
          JSON.stringify({ error: 'unauthorized', message: 'authentication is required' }),
          { status: 401, headers }
        )
      }
    }

    // ------------------------------------------------------------- cross site
    //
    // A caller that authenticated with a session cookie is a browser, and a
    // browser can be made to send a request from another site. The guard
    // refuses the requests that change the state of an upstream. A caller
    // that authenticated with a bearer token is not a browser, so it is not
    // affected.
    //
    // The guard does not only look at the credential that authenticated the
    // request: a browser sends its session cookie to every path of the
    // gateway, also to the routes that do not authenticate. A request that
    // carries the cookie is a request of a browser, so it is guarded even
    // when the route has no policy of its own.
    if (principal?.source === 'session' || runtime.auth.hasSessionCookie(c)) {
      const crossSite = checkCrossSite({
        method,
        headers: c.req.raw.headers,
        host,
        // The effective protocol: the one the trusted proxy reports, so the
        // origin of the request is the one the browser actually used.
        externalProto: forwarding.proto,
        allowedOrigins: runtime.options.allowedOrigins,
        strict: runtime.options.csrfStrict,
      })
      if (!crossSite.allowed) {
        logger.warn('a cross site request was refused', {
          requestId,
          routeId: route.id,
          reason: crossSite.reason,
        })
        runtime.metrics.recordCrossSiteRefusal(route.id)
        return jsonError(403, 'cross_site_request', crossSite.reason ?? 'the request was refused')
      }
    }

    // ------------------------------------------------------------ workspace
    let workspaceId: string | undefined
    if (route.auth.workspace) {
      const raw = match.params[route.auth.workspace.param]
      if (!raw) {
        return jsonError(400, 'bad_request', 'the workspace identifier is missing from the request path')
      }
      if (route.auth.workspace.requireUuid && !isUuid(raw)) {
        return jsonError(400, 'bad_request', 'the workspace identifier is not a valid UUID')
      }
      workspaceId = raw
      if (principal) {
        const decision = await runtime.access.decide({
          subject: principal.subject,
          workspaceId,
          routeId: route.id,
          roles: principal.roles,
        })
        if (!decision.allow) {
          runtime.metrics.recordAuthFailure(route.id, authFailureReason(decision.reason))
          logger.warn('workspace access denied', {
            requestId,
            routeId: route.id,
            workspaceId,
            reason: decision.reason,
          })
          // The reason of the access service is not given to the caller: it
          // describes the policy of the platform and it is not the business
          // of the client.
          return jsonError(403, 'workspace_forbidden', 'the workspace is not available to this caller', {
            workspaceId,
          })
        }
      }
    }

    // ------------------------------------------------------------- websocket
    const isUpgrade = (c.req.header('upgrade') ?? '').toLowerCase() === 'websocket'
    if (isUpgrade) {
      if (!route.websocket) {
        return jsonError(400, 'websocket_not_allowed', 'this route does not accept websocket connections')
      }
      const server = c.env
      if (!server || typeof server.upgrade !== 'function') {
        return jsonError(500, 'websocket_unavailable', 'websocket support is not available')
      }
      const upstreamUrl = buildWebsocketUrl(route.upstream, path, url.search)
      const headers = buildUpstreamHeaders({
        incoming: c.req.raw.headers,
        forwarding,
        identity: principal
          ? {
              subject: principal.subject,
              email: principal.email,
              roles: principal.roles,
              workspaceId,
            }
          : undefined,
        signature: principal
          ? identitySignature(principal, workspaceId, method, path, url.search, host)
          : undefined,
      })
      const forwardHeaders: Record<string, string> = {}
      headers.forEach((value, key) => {
        if (key === 'host' || key === 'connection' || key === 'upgrade') return
        // The handshake headers belong to the handshake of the client. The
        // gateway performs a handshake of its own with the upstream, so the
        // keys, the version and the compression of the client do not apply
        // to it.
        if (HANDSHAKE_HEADERS.includes(key)) return
        forwardHeaders[key] = value
      })

      // The number of open connections is bounded, so a caller cannot open
      // connections until the process runs out of memory.
      if (!websockets.reserve()) {
        logger.warn('the websocket connection limit was reached', { requestId, routeId: route.id })
        runtime.metrics.recordWebsocketRefusal('connection_limit')
        return jsonError(503, 'too_many_connections', 'the gateway has too many open connections')
      }

      // The upstream is connected before the client is answered: the gateway
      // knows the outcome of the upstream handshake and the subprotocol the
      // upstream selected, and it can pass both on to the client.
      const protocols = offeredProtocols(c.req.header('sec-websocket-protocol'))
      let upstream: UpstreamWebSocket
      try {
        upstream = await connectUpstream({
          url: upstreamUrl,
          headers: forwardHeaders,
          protocols,
          handshakeTimeoutMs: runtime.options.websocketHandshakeTimeoutMs,
        })
      } catch (error) {
        websockets.releasePending()
        logger.warn('the upstream websocket handshake failed', {
          requestId,
          routeId: route.id,
          upstream: upstreamUrl,
          error,
        })
        runtime.metrics.recordWebsocketRefusal('upstream_unavailable')
        return jsonError(502, 'bad_gateway', 'the upstream did not accept the websocket connection')
      }

      const selected = upstream.protocol ?? ''
      const now = Date.now()
      const data: WebSocketContext = {
        routeId: route.id,
        upstreamUrl,
        headers: forwardHeaders,
        requestId,
        maxBufferedBytes: runtime.options.websocketMaxBufferedBytes,
        maxBufferedMessages: runtime.options.websocketMaxBufferedMessages,
        upstream,
        protocol: selected,
        buffer: [],
        bufferedBytes: 0,
        closed: false,
        lastPongAt: now,
        lastUpstreamPongAt: now,
        openedAt: now,
        backpressure: 0,
      }
      const upgraded = server.upgrade(c.req.raw, {
        data,
        // The subprotocol the upstream selected is confirmed to the client,
        // so both sides speak the same protocol.
        headers: selected ? { 'sec-websocket-protocol': selected } : undefined,
      })
      if (!upgraded) {
        websockets.releasePending()
        try {
          upstream.terminate()
        } catch {
          /* the connection is already gone */
        }
        return jsonError(400, 'websocket_upgrade_failed', 'the websocket upgrade was rejected')
      }
      runtime.metrics.recordWebsocket(route.id)
      logger.info('websocket upgraded', {
        requestId,
        routeId: route.id,
        upstream: upstreamUrl,
        protocol: selected,
      })
      return new Response(null)
    }

    // ----------------------------------------------------------------- http
    const headers = buildUpstreamHeaders({
      incoming: c.req.raw.headers,
      forwarding,
      identity: principal
        ? {
            subject: principal.subject,
            email: principal.email,
            roles: principal.roles,
            workspaceId,
          }
        : undefined,
      signature: principal
        ? identitySignature(principal, workspaceId, method, path, url.search, host)
        : undefined,
    })

    // Every budget of the route wins over the budget of the configuration,
    // field by field: a route that only sets `connectMs` keeps the header
    // and the body budget of the configuration.
    const timeouts = resolveTimeouts(state.config.defaults.timeouts, route.timeouts)
    // The limit of the route wins, then the limit of the configuration, then
    // the limit of the environment.
    const maxBodyBytes =
      route.maxBodyBytes ?? state.config.defaults.maxBodyBytes ?? runtime.options.maxBodyBytes
    const upstreamUrl = buildUpstreamUrl(route.upstream, path, url.search)

    const result = await forwardRequest({
      request: c.req.raw,
      url: upstreamUrl,
      headers,
      timeouts,
      maxBodyBytes,
      clientSignal: c.req.raw.signal,
    })

    const durationMs = Date.now() - started

    if (result.error) {
      const status =
        result.error.kind === 'too_large'
          ? 413
          : result.error.kind === 'timeout'
            ? 504
            : result.error.kind === 'aborted'
              ? 499
              : 502
      runtime.metrics.recordRequest({
        routeId: route.id,
        method,
        status,
        durationMs,
        bytesIn: result.bytesIn,
        bytesOut: 0,
      })
      logger.warn('upstream request failed', {
        requestId,
        routeId: route.id,
        upstream: upstreamUrl,
        kind: result.error.kind,
        error: result.error.message,
      })
      if (status === 499) {
        return new Response(null, { status: 499 })
      }
      return jsonError(status, status === 413 ? 'payload_too_large' : 'bad_gateway', result.error.message)
    }

    const response = result.response!
    const responseHeaders = new Headers(response.headers)
    responseHeaders.set('x-request-id', requestId)

    // The redirects of the upstream are rewritten so that they stay inside
    // the gateway: an absolute location would name the internal host of the
    // upstream, and a relative one would leave the prefix the application
    // is mounted under.
    if (route.redirects === 'rewrite') {
      const location = responseHeaders.get('location')
      if (location) {
        const rewritten = rewriteLocation(location, {
          upstreamOrigin: upstreamOriginOf(route.upstream),
          mountPrefix: mountPrefixOf(route.upstream, match.prefix),
        })
        if (rewritten !== location) {
          responseHeaders.set('location', rewritten)
        }
      }
    }

    // The metrics and the log of a request are written when the response
    // body is completely streamed, not when the headers arrived: the
    // duration of a request is the time the caller waited, and the number
    // of bytes is the number of bytes that were really transferred.
    const status = response.status
    let bytesOut = 0
    let recorded = false
    const record = (outcome: 'complete' | 'aborted'): void => {
      if (recorded) return
      recorded = true
      const totalMs = Date.now() - started
      runtime.metrics.recordRequest({
        routeId: route.id,
        method,
        status,
        durationMs: totalMs,
        bytesIn: result.bytesIn,
        bytesOut,
      })
      logger.info('request proxied', {
        requestId,
        routeId: route.id,
        method,
        // The query string is logged, the token bearing parameters are
        // redacted from it.
        path: redactUrl(`${path}${url.search}`),
        status,
        durationMs: totalMs,
        bytesIn: result.bytesIn,
        bytesOut,
        outcome,
      })
    }

    if (!response.body) {
      record('complete')
      return new Response(null, {
        status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    }

    // The body is counted while it streams. A client that goes away in the
    // middle of the response is reported as an aborted request, the metric
    // is written in every case.
    const reader = response.body.getReader()
    const tracked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            record('complete')
            return
          }
          if (value) {
            bytesOut += value.byteLength
            controller.enqueue(value)
          }
        } catch (error) {
          record('aborted')
          controller.error(error)
        }
      },
      cancel(reason) {
        record('aborted')
        return reader.cancel(reason)
      },
    })

    return new Response(tracked, {
      status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  app.all('*', async (c) => {
    const requestId = c.get('requestId') ?? resolveRequestId(c)
    const started = Date.now()
    runtime.metrics.requestStarted()
    try {
      return await dispatch(c, requestId, started)
    } catch (error) {
      logger.error('unhandled gateway error', { requestId, error })
      return jsonError(500, 'internal_error', 'the gateway failed to handle the request')
    } finally {
      runtime.metrics.requestFinished()
    }
  })

  app.onError((error, c) => {
    logger.error('gateway error', { error, path: c.req.path })
    return jsonError(500, 'internal_error', 'the gateway failed to handle the request')
  })

  return app
}
