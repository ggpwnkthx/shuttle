#!/usr/bin/env bun
/**
 * The reference implementation of the access service.
 *
 * The gateway never decides access on its own: it asks a service that owns
 * the workspaces, the roles and the quotas. That service is not part of
 * Shuttle, and this file is a **reference implementation** of the protocol
 * of §6 of the specification: a deployment that has no service of its own
 * may deploy this one and write a policy file, and a deployment that has
 * one may use it to check that its implementation speaks the protocol (see
 * `test/integration/access-conformance.ts`).
 *
 * It is not a fixture: the fixtures of `services/` carry accounts with
 * known passwords and refuse to run in a production environment. This
 * service carries a policy that the operator writes, and it runs anywhere.
 *
 * The policy file:
 *
 * ```json
 * {
 *   "version": 1,
 *   "subjects": {
 *     "alice@example.com": {
 *       "workspaces": ["11111111-1111-4111-8111-111111111111"],
 *       "roles": ["editor"]
 *     },
 *     "bob@example.com": { "workspaces": ["*"] },
 *     "carol@example.com": { "workspaces": [], "routes": ["admin-api"] }
 *   }
 * }
 * ```
 *
 * | Field | Meaning |
 * | --- | --- |
 * | `version` | The version of the file. Only `1` is understood. |
 * | `subjects` | The subjects the service knows, by their identifier. |
 * | `workspaces` | The workspaces the subject may use. `"*"` is every workspace. |
 * | `routes` | The routes the subject may use when the request names no workspace. `"*"` is every route. A subject that has none is denied for a request that names no workspace. |
 * | `roles` | The roles the subject needs. The request must carry one of them. |
 *
 * A subject that the file does not know is denied. The service never
 * decides on its own: it applies the file, and it says no when the file
 * says nothing.
 *
 * The environment:
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `ACCESS_POLICY_FILE` | The path of the policy file. It is required. |
 * | `ACCESS_SERVICE_TOKEN` | The token the gateway presents. Required in production. |
 * | `PORT` | The port to listen on, `8090` by default. |
 * | `SHUTTLE_ACCESS_LOG_DECISIONS` | `true` writes every decision in the log. |
 */

import { readFileSync } from 'node:fs'

/** The policy of a subject. */
export interface SubjectPolicy {
  /** The workspaces the subject may use. `"*"` is every workspace. */
  workspaces: string[]
  /**
   * The routes the subject may use when the request names no workspace.
   *
   * `"*"` is every route. A subject that has no route is denied for a
   * request that names no workspace.
   */
  routes?: string[]
  /** The roles the subject needs. */
  roles?: string[]
  /** The reason of a denial, when the policy wants to name one. */
  reason?: string
}

/** The policy file of the service. */
export interface AccessPolicyFile {
  version: number
  subjects: Record<string, SubjectPolicy>
}

export interface AccessServiceOptions {
  /** The policy of the service. */
  policy: AccessPolicyFile
  /** The token the gateway presents. The service refuses the calls without it. */
  token?: string
  /** The port to listen on, 0 picks a free one. */
  port?: number
  hostname?: string
  /** Called for every decision, for the log of the service. */
  onDecision?: (decision: {
    subject: string
    workspaceId?: string
    routeId: string
    allow: boolean
    reason: string
  }) => void
}

/** The decision of the service for a request. */
export interface Decision {
  allow: boolean
  reason?: string
}

/**
 * Reads a policy file and refuses the ones it does not understand.
 *
 * A policy that is half read is a policy nobody can reason about: the
 * service refuses to start rather than apply half of it.
 */
export function parsePolicyFile(raw: string, source: string): AccessPolicyFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `the policy file ${source} is not valid json: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the policy file ${source} is not an object`)
  }
  const file = parsed as Partial<AccessPolicyFile>
  if (file.version !== 1) {
    throw new Error(`the policy file ${source} has the version ${String(file.version)}, expected 1`)
  }
  if (typeof file.subjects !== 'object' || file.subjects === null) {
    throw new Error(`the policy file ${source} has no subjects`)
  }
  for (const [subject, policy] of Object.entries(file.subjects)) {
    if (typeof policy !== 'object' || policy === null) {
      throw new Error(`the subject ${subject} of the policy file ${source} is not an object`)
    }
    if (!Array.isArray(policy.workspaces)) {
      throw new Error(`the subject ${subject} of the policy file ${source} has no workspaces`)
    }
    for (const workspace of policy.workspaces) {
      if (typeof workspace !== 'string') {
        throw new Error(`the subject ${subject} of the policy file ${source} has a bad workspace`)
      }
    }
    if (policy.roles !== undefined && !Array.isArray(policy.roles)) {
      throw new Error(`the subject ${subject} of the policy file ${source} has bad roles`)
    }
    if (policy.routes !== undefined) {
      if (!Array.isArray(policy.routes)) {
        throw new Error(`the subject ${subject} of the policy file ${source} has bad routes`)
      }
      for (const route of policy.routes) {
        if (typeof route !== 'string') {
          throw new Error(`the subject ${subject} of the policy file ${source} has a bad route`)
        }
      }
    }
  }
  return file as AccessPolicyFile
}

/**
 * Applies the policy to a request.
 *
 * The order is the order of the specification: the subject is known, it has
 * the role it needs, and it may use the workspace.
 *
 * A request that names no workspace is decided by the routes of the
 * subject: the deployment that has no workspaces writes the routes it
 * protects there.
 */
export function decide(
  policy: AccessPolicyFile,
  request: { subject: string; workspaceId?: string; routeId?: string; roles?: string[] }
): Decision {
  const subject = policy.subjects[request.subject]
  if (!subject) {
    return { allow: false, reason: 'the subject is not known to the access service' }
  }
  const roles = request.roles ?? []
  if (subject.roles && subject.roles.length > 0) {
    const held = subject.roles.some((role) => roles.includes(role))
    if (!held) {
      return {
        allow: false,
        reason: subject.reason ?? 'the subject does not have the role of the workspace',
      }
    }
  }
  if (request.workspaceId !== undefined) {
    const workspaces = subject.workspaces
    const allowed = workspaces.includes('*') || workspaces.includes(request.workspaceId)
    if (!allowed) {
      return {
        allow: false,
        reason: subject.reason ?? 'the subject may not use the workspace',
      }
    }
    return { allow: true }
  }
  // The request names no workspace: the routes of the subject decide.
  const routes = subject.routes ?? []
  const routeId = request.routeId ?? ''
  const allowed = routes.includes('*') || routes.includes(routeId)
  if (!allowed) {
    return {
      allow: false,
      reason: subject.reason ?? 'the subject may not use the route',
    }
  }
  return { allow: true }
}

export interface StartedAccessService {
  url: string
  port: number
  stop: () => Promise<void>
}

/**
 * Starts the reference access service.
 *
 * The service is a plain HTTP service: it answers the decision requests of
 * the gateway and nothing else.
 */
export async function startAccessService(
  options: AccessServiceOptions
): Promise<StartedAccessService> {
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '0.0.0.0',
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok', service: 'shuttle-access-service' })
      }
      if (url.pathname !== '/v1/decisions') {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (options.token) {
        const authorization = request.headers.get('authorization') ?? ''
        if (authorization !== `Bearer ${options.token}`) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
      }
      if (request.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405 })
      }

      let body: { subject?: unknown; workspaceId?: unknown; routeId?: unknown; roles?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return Response.json({ error: 'bad_request' }, { status: 400 })
      }
      const subject = typeof body.subject === 'string' ? body.subject : ''
      // The workspace is optional: a request that names none is decided by
      // the routes of the subject. A workspace that is there and is empty
      // is a malformed request.
      const hasWorkspace = body.workspaceId !== undefined && body.workspaceId !== null
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
      const routeId = typeof body.routeId === 'string' ? body.routeId : ''
      const roles = Array.isArray(body.roles)
        ? body.roles.filter((r): r is string => typeof r === 'string')
        : []
      if (subject === '' || (hasWorkspace && workspaceId === '')) {
        return Response.json({ error: 'bad_request' }, { status: 400 })
      }

      const decision = decide(options.policy, { subject, workspaceId, routeId, roles })
      options.onDecision?.({
        subject,
        workspaceId,
        routeId,
        allow: decision.allow,
        reason: decision.reason ?? (decision.allow ? 'allowed' : 'denied'),
      })
      return decision.allow
        ? Response.json({ allow: true })
        : Response.json({ allow: false, reason: decision.reason ?? 'denied' })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port ?? 0}`,
    port: server.port ?? 0,
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const production = process.env.NODE_ENV === 'production'
  const policyPath = process.env.ACCESS_POLICY_FILE
  const token = process.env.ACCESS_SERVICE_TOKEN

  if (!policyPath) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'the access service needs a policy file',
        hint: 'set ACCESS_POLICY_FILE to the path of the policy file',
      })
    )
    process.exit(1)
  }
  if (production && !token) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'the access service needs a token in a production environment',
        hint: 'set ACCESS_SERVICE_TOKEN to the token the gateway presents',
      })
    )
    process.exit(1)
  }

  let policy: AccessPolicyFile
  try {
    policy = parsePolicyFile(readFileSync(policyPath, 'utf8'), policyPath)
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'the policy of the access service could not be read',
        error: error instanceof Error ? error.message : String(error),
      })
    )
    process.exit(1)
  }

  const logDecisions = process.env.SHUTTLE_ACCESS_LOG_DECISIONS === 'true'
  const service = await startAccessService({
    policy,
    token,
    port: Number(process.env.PORT ?? '8090'),
    onDecision: (decision) => {
      if (!logDecisions) return
      console.log(
        JSON.stringify({ level: 'info', msg: 'the decision of the service', ...decision })
      )
    },
  })

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the reference access service started',
      port: service.port,
      subjects: Object.keys(policy.subjects).length,
    })
  )

  const shutdown = (): void => {
    void service.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
