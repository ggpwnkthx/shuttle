/**
 * The application of the gateway.
 *
 * The application is thin on purpose: it holds the order of the pipeline,
 * it maps the failures of the domains to the answers of the protocol and it
 * writes the headers and the cookies of the answers. Every rule lives in a
 * domain.
 */

import { randomUUID } from 'node:crypto'
import { Hono, type Context, type ExecutionContext } from 'hono'
import { serializeCookie } from '../domains/authentication'
import { GATEWAY_ENDPOINTS } from '../domains/configuration'
import { resolveForwardingContext } from '../domains/forwarding'
import type { GatewayDependencies } from './dependencies'
import { dispatch } from './dispatcher'
import {
  callbackHandler,
  healthHandler,
  loginHandler,
  logoutHandler,
  metricsHandler,
  readyHandler,
} from './endpoints'
import { jsonError } from './errors'
import type { GatewayEnv, GatewayState } from './state'

/** The shape of the identifier of a request. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The identifier of a request.
 *
 * The identifier of the request is reused when it is valid: a client that
 * sends one can follow its request in the logs. An identifier that is not
 * valid is replaced by a generated one: the identifier ends up in a log
 * line and in a header, so it may not carry anything else.
 */
function resolveRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id')
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming
  return randomUUID()
}

/** The state of a request that has just arrived. */
function initialState(request: Request): GatewayState {
  return {
    requestId: resolveRequestId(request),
    startedAt: Date.now(),
    snapshot: null,
    forwarding: null,
    cookies: [],
  }
}

/**
 * The forwarding context of a request.
 *
 * The endpoints of the gateway compute it themselves: the limiter of the
 * logins is keyed by the address of the caller.
 */
function forwardingOf(
  context: Context<GatewayEnv>,
  dependencies: GatewayDependencies
): ReturnType<typeof resolveForwardingContext> {
  const snapshot = dependencies.config.snapshot
  return resolveForwardingContext({
    peerAddress: dependencies.peerAddress(context.req.raw),
    headers: context.req.raw.headers,
    trustedProxies: snapshot?.trustedProxies ?? [],
    externalProto: dependencies.externalProto,
  })
}

/**
 * The application, as the listener of the platform sees it.
 *
 * The platform does not know the framework of the application: the
 * application answers the requests itself and hands the platform the
 * capabilities it needs.
 */
export interface GatewayHandler {
  handle(request: Request, env: GatewayEnv['Bindings']): Response | Promise<Response>
}

/**
 * Wraps the application of the gateway for the listener of the platform.
 */
export function createGatewayHandler(app: Hono<GatewayEnv>): GatewayHandler {
  const executionCtx: ExecutionContext = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  }
  return {
    handle: (request, env) => app.fetch(request, env, executionCtx),
  }
}

/**
 * Builds the application of the gateway.
 */
export function createGatewayApp(dependencies: GatewayDependencies): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>()

  // The identifier of the request is the first thing: it is in every log
  // line of the request and in the answer.
  app.use('*', async (context, next) => {
    const state = initialState(context.req.raw)
    context.set('requestId', state.requestId)
    context.set('startedAt', state.startedAt)
    context.set('snapshot', state.snapshot)
    context.set('forwarding', state.forwarding)
    context.set('cookies', state.cookies)
    await next()
    try {
      context.res.headers.set('x-request-id', state.requestId)
      for (const cookie of context.get('cookies')) {
        context.res.headers.append('set-cookie', serializeCookie(cookie))
      }
    } catch {
      // The headers of the answer are immutable, there is nothing to do.
    }
  })

  // The endpoints of the gateway. They are matched before the route table
  // is consulted.
  app.get(GATEWAY_ENDPOINTS.health, (context) => healthHandler(context, dependencies))
  app.get(GATEWAY_ENDPOINTS.ready, (context) => readyHandler(context, dependencies))
  app.get(GATEWAY_ENDPOINTS.metrics, (context) => metricsHandler(context, dependencies))
  app.get(GATEWAY_ENDPOINTS.login, async (context) => {
    context.set('forwarding', forwardingOf(context, dependencies))
    return await loginHandler(context, dependencies)
  })
  app.get(GATEWAY_ENDPOINTS.callback, (context) => callbackHandler(context, dependencies))
  app.get(GATEWAY_ENDPOINTS.logout, (context) => logoutHandler(context, dependencies))

  // Everything else is dispatched.
  app.all('*', async (context) => {
    const requestId = context.get('requestId')
    const started = context.get('startedAt')
    dependencies.observer.requestStarted()
    try {
      return await dispatch(context, dependencies, requestId, started)
    } catch (error) {
      dependencies.logger.error('the gateway failed to handle the request', { requestId, error })
      return jsonError(500, 'internal_error', 'the gateway failed to handle the request')
    } finally {
      dependencies.observer.requestFinished()
    }
  })

  app.onError((error, context) => {
    dependencies.logger.error('the gateway failed to handle the request', {
      requestId: context.get('requestId'),
      error,
    })
    return jsonError(500, 'internal_error', 'the gateway failed to handle the request')
  })

  return app
}
