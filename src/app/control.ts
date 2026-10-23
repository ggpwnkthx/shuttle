/**
 * The application of the control plane.
 *
 * The application maps the requests of the protocol to the calls of the
 * service of the control plane and it maps the outcomes to the statuses of
 * the protocol. Every rule lives in the domain: the application decides
 * nothing but the shape of the answers.
 *
 * The control plane is **internal**: it listens on its own socket, on the
 * network of the deployment, and it is never routed through the gateway
 * (§12.7 of the specification).
 */

import { randomUUID } from 'node:crypto'
import { Hono, type Context, type ExecutionContext } from 'hono'
import {
  findControlIdentity,
  scopeAllows,
  type ControlCapability,
  type ControlIdentity,
  type ControlService,
} from '../domains/control'
import type { Logger } from '../observability'

/** The number of failed authentications an address may make in the window. */
export const MAX_FAILED_AUTHENTICATIONS = 5

/** The state of a request of the control plane. */
export interface ControlState {
  /** The identifier of the request; it is in every log line of the request. */
  requestId: string
  /** The moment the request arrived, in milliseconds. */
  startedAt: number
  /** The operator behind the token of the request, when it carried one. */
  identity: ControlIdentity | null
  /** The address of the caller. */
  address: string
}

/** The environment of the application of the control plane. */
export interface ControlEnv {
  Bindings: Record<string, never>
  Variables: ControlState
}

/** The dependencies of the application of the control plane. */
export interface ControlDependencies {
  /** The service of the control plane. */
  service: ControlService
  /** The logger of the control plane. */
  logger: Logger
  /** The version of the release. */
  version: string
  /** The address of the peer of a request. */
  peerAddress: (request: Request) => string
  /** True while the control plane is draining. */
  isDraining?: () => boolean
}

/** The application of the control plane, as the listener of the platform sees it. */
export interface ControlHandler {
  handle(request: Request, env: never): Response | Promise<Response>
}

/** Wraps the application of the control plane for the listener of the platform. */
export function createControlHandler(app: Hono<ControlEnv>): ControlHandler {
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
 * Builds the application of the control plane.
 */
export function createControlApp(dependencies: ControlDependencies): Hono<ControlEnv> {
  const app = new Hono<ControlEnv>()

  app.use('*', async (context, next) => {
    context.set('requestId', randomUUID())
    context.set('startedAt', Date.now())
    context.set('identity', null)
    context.set('address', dependencies.peerAddress(context.req.raw))
    await next()
    try {
      context.res.headers.set('x-request-id', context.get('requestId'))
    } catch {
      // The headers of the answer are immutable, there is nothing to do.
    }
  })

  // The health of the process: it says that the process answers.
  app.get('/healthz', (context) =>
    context.json({
      status: 'ok',
      service: 'shuttle-control',
      version: dependencies.version,
      uptimeMs: Date.now() - context.get('startedAt'),
    })
  )

  // The readiness of the control plane: it is ready when the shared state
  // it acts on answers.
  app.get('/readyz', async (context) => {
    const draining = dependencies.isDraining?.() ?? false
    let state = false
    try {
      state = await dependencies.service.ping()
    } catch {
      state = false
    }
    const ready = state && !draining
    return context.json(
      {
        status: ready ? 'ready' : draining ? 'draining' : 'not-ready',
        state: state ? 'ok' : 'unavailable',
      },
      ready ? 200 : 503
    )
  })

  // Every other endpoint is authenticated: a token, and a scope.
  app.use('/v1/*', async (context, next) => {
    const address = context.get('address')
    let failures = 0
    try {
      failures = await dependencies.service.failureCount(address)
    } catch (error) {
      // The counter of the failures lives in the shared state. A limit
      // that cannot be counted is not a limit: the request is refused.
      dependencies.logger.warn('the counter of the failed authentications is not reachable', {
        error,
      })
      return jsonError(
        503,
        'control_state_unavailable',
        'the shared state of the control plane cannot be reached'
      )
    }
    if (failures >= MAX_FAILED_AUTHENTICATIONS) {
      return jsonError(
        429,
        'too_many_failed_authentications',
        'too many failed authentications from this address',
        undefined,
        { 'retry-after': '60' }
      )
    }
    const token = tokenOf(context.req.raw)
    const identity = findControlIdentity(dependencies.service.tokens, token)
    if (!identity) {
      try {
        await dependencies.service.recordFailure(address)
      } catch (error) {
        dependencies.logger.warn('the counter of the failed authentications is not reachable', {
          error,
        })
        return jsonError(
          503,
          'control_state_unavailable',
          'the shared state of the control plane cannot be reached'
        )
      }
      dependencies.logger.warn('the control plane refused a token', {
        requestId: context.get('requestId'),
        address,
      })
      return jsonError(401, 'unauthorized', 'a valid token is required')
    }
    context.set('identity', identity)
    await next()
    return undefined
  })

  // The route table of the deployment.
  app.get('/v1/config', async (context) => {
    const refused = refuseUnless(context, 'read')
    if (refused) return refused
    const active = await dependencies.service.activeConfig()
    const validation =
      active.table === null ? null : await dependencies.service.validate(active.table)
    return context.json({
      revision: active.revision,
      table: active.table,
      author: active.author,
      createdAt: active.createdAt,
      source: 'store',
      warnings: validation?.warnings ?? [],
    })
  })

  app.post('/v1/config/validate', async (context) => {
    const refused = refuseUnless(context, 'read')
    if (refused) return refused
    const table = await readJson(context.req.raw)
    if (table === undefined) {
      return jsonError(400, 'invalid_body', 'the body is not valid json')
    }
    const validation = await dependencies.service.validate(table)
    return context.json(validation, validation.ok ? 200 : 422)
  })

  app.put('/v1/config', async (context) => {
    const refused = refuseUnless(context, 'config')
    if (refused) return refused
    const expected = expectedRevision(context.req.raw)
    if (expected === undefined) {
      return jsonError(
        400,
        'if_match_required',
        'the write has to carry the revision it replaces in the if-match header'
      )
    }
    const table = await readJson(context.req.raw)
    if (table === undefined) {
      return jsonError(400, 'invalid_body', 'the body is not valid json')
    }
    const identity = context.get('identity')!
    const outcome = await dependencies.service.writeConfig({
      table,
      // The revision zero is the revision before the first one: it says
      // that the store is empty.
      expectedRevision: expected === 0 ? null : expected,
      identity,
      address: context.get('address'),
      request: { action: 'config.write' },
    })
    if (outcome.ok) return context.json({ revision: outcome.revision })
    if (outcome.reason === 'conflict') {
      return jsonError(409, 'revision_conflict', 'the active revision is not the expected one', {
        active: outcome.active,
      })
    }
    if (outcome.reason === 'protected') {
      return jsonError(409, 'protected_route', 'the write changes a protected route', {
        routes: outcome.routes,
      })
    }
    return jsonError(422, 'invalid_configuration', 'the table is not valid', {
      errors: outcome.errors,
      conflicts: outcome.conflicts,
    })
  })

  app.get('/v1/config/history', async (context) => {
    const refused = refuseUnless(context, 'read')
    if (refused) return refused
    const page = await dependencies.service.history(pageOf(context.req.raw))
    return context.json(page)
  })

  app.post('/v1/config/rollback', async (context) => {
    const refused = refuseUnless(context, 'config')
    if (refused) return refused
    const body = (await readJson(context.req.raw)) as { revision?: unknown } | undefined
    if (body === undefined || typeof body.revision !== 'number') {
      return jsonError(400, 'invalid_body', 'the body has to carry the number of the revision')
    }
    const identity = context.get('identity')!
    const expected = expectedRevision(context.req.raw)
    const outcome = await dependencies.service.rollback({
      revision: body.revision,
      expectedRevision: expected ?? null,
      identity,
      address: context.get('address'),
    })
    if (outcome.ok) return context.json({ revision: outcome.revision })
    if (outcome.reason === 'conflict') {
      return jsonError(409, 'revision_conflict', 'the active revision is not the expected one', {
        active: outcome.active,
      })
    }
    if (outcome.reason === 'protected') {
      return jsonError(409, 'protected_route', 'the write changes a protected route', {
        routes: outcome.routes,
      })
    }
    return jsonError(422, 'invalid_configuration', 'the revision cannot be written again', {
      errors: outcome.errors,
      conflicts: outcome.conflicts,
    })
  })

  // The replicas that serve the route table.
  app.get('/v1/replicas', async (context) => {
    const refused = refuseUnless(context, 'read')
    if (refused) return refused
    const replicas = await dependencies.service.replicas()
    return context.json({ replicas })
  })

  // The sessions of a caller.
  app.delete('/v1/sessions', async (context) => {
    const refused = refuseUnless(context, 'operate')
    if (refused) return refused
    const subject = context.req.query('subject')
    if (!subject) {
      return jsonError(400, 'invalid_query', 'the query has to carry the subject')
    }
    const identity = context.get('identity')!
    const removed = await dependencies.service.revokeSessions({
      subject,
      identity,
      address: context.get('address'),
    })
    return context.json({ revoked: removed })
  })

  // The cached decisions of a caller.
  app.delete('/v1/decisions', async (context) => {
    const refused = refuseUnless(context, 'operate')
    if (refused) return refused
    const subject = context.req.query('subject')
    const workspace = context.req.query('workspace')
    if (!subject && !workspace) {
      return jsonError(400, 'invalid_query', 'the query has to carry the subject or the workspace')
    }
    const identity = context.get('identity')!
    const removed = await dependencies.service.purgeDecisions({
      subject,
      workspaceId: workspace,
      identity,
      address: context.get('address'),
    })
    return context.json({ purged: removed })
  })

  // The trail of the writes.
  app.get('/v1/audit', async (context) => {
    const refused = refuseUnless(context, 'read')
    if (refused) return refused
    const page = await dependencies.service.audit(pageOf(context.req.raw))
    return context.json(page)
  })

  app.onError((error, context) => {
    dependencies.logger.error('the control plane failed to handle the request', {
      requestId: context.get('requestId'),
      error,
    })
    return jsonError(500, 'internal_error', 'the control plane failed to handle the request')
  })

  return app
}

/**
 * Refuses a request whose scope is not enough.
 *
 * A token of the wrong scope is refused with `403`: the caller is
 * authenticated and it may not do this.
 */
function refuseUnless(
  context: Context<ControlEnv>,
  capability: ControlCapability
): Response | null {
  const identity = context.get('identity')
  if (!identity) {
    return jsonError(401, 'unauthorized', 'a valid token is required')
  }
  if (!scopeAllows(identity.scope, capability)) {
    return jsonError(403, 'forbidden', 'the token does not hold the scope of this endpoint')
  }
  return null
}

/**
 * The token of a request.
 *
 * It is the bearer token of the request, or the header the control plane
 * reads when the caller cannot send an authorization header.
 */
function tokenOf(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match) return match[1]!.trim()
  }
  return request.headers.get('x-shuttle-control-token')
}

/**
 * The revision the caller believes is active.
 *
 * The header carries the number of the revision, with or without the
 * quotes of the standard.
 */
function expectedRevision(request: Request): number | undefined {
  const header = request.headers.get('if-match')
  if (!header) return undefined
  const value = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  if (!/^\d+$/.test(value)) return undefined
  const revision = Number(value)
  return Number.isFinite(revision) ? revision : undefined
}

/** The page of a list, from the query of the request. */
function pageOf(request: Request): { limit: number; offset: number } {
  const parameters = new URL(request.url).searchParams
  const limit = Number(parameters.get('limit') ?? '50')
  const offset = Number(parameters.get('offset') ?? '0')
  return {
    limit: Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50,
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
  }
}

/** Reads the body of a request, or undefined when it is not valid json. */
async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text()
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The body of a refusal of the control plane. */
function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
