#!/usr/bin/env bun
/**
 * The access fixture: a stand in for the service that owns the workspaces.
 *
 * It answers the decision requests of the gateway with a static policy. The
 * gateway never decides access on its own, so this fixture is what the tests
 * and the development stack talk to.
 */
import { assertFixtureAllowed, FixtureInProductionError } from './fixture-guard'

/**
 * The workspaces a subject may use.
 *
 * A plain list of workspace identifiers is the normal case. The object form
 * adds a custom denial reason, which is how a role based denial is
 * simulated.
 */
export type AccessPolicyEntry = string[] | { workspaces: string[]; reason?: string }

export type AccessPolicy = Record<string, AccessPolicyEntry>

export interface AccessServiceOptions {
  policy?: AccessPolicy
  /** Optional service token that callers must present. */
  token?: string
  /** Simulates an unavailable access service (used to test fail-closed behaviour). */
  unavailable?: boolean
  /** The port to listen on, 0 picks a free one. */
  port?: number
  hostname?: string
}

/**
 * The default development policy: one user may use one workspace, everybody
 * else is denied.
 */
export const DEFAULT_POLICY: AccessPolicy = {
  'user-alice': ['11111111-1111-4111-8111-111111111111'],
  'alice@shuttle.test': ['11111111-1111-4111-8111-111111111111'],
}

/** The entry of a subject, with its reason. */
function entryOf(entry: AccessPolicyEntry): { workspaces: string[]; reason?: string } {
  return Array.isArray(entry) ? { workspaces: entry } : entry
}

export interface StartedAccessService {
  url: string
  port: number
  /** The decision requests the service received, for the tests. */
  requests: { subject: string; workspaceId: string; routeId: string; roles: string[] }[]
  /**
   * Changes the policy of the service while it runs.
   *
   * The tests use it to revoke an access and to give it back, without
   * restarting the service.
   */
  setPolicy: (policy: AccessPolicy) => void
  stop: () => Promise<void>
}

/**
 * Starts the access fixture.
 *
 * The fixture makes the authorization decisions with a static policy: it is
 * a stand in for a real access service, never one itself.
 */
export async function startAccessService(
  options: AccessServiceOptions = {}
): Promise<StartedAccessService> {
  assertFixtureAllowed('access service')
  let policy = options.policy ?? DEFAULT_POLICY
  const requests: StartedAccessService['requests'] = []

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok', service: 'shuttle-access-fixture' })
      }
      if (url.pathname !== '/v1/decisions') {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (options.unavailable) {
        return Response.json({ error: 'unavailable' }, { status: 503 })
      }
      if (options.token) {
        const authorization = request.headers.get('authorization') ?? ''
        if (authorization !== `Bearer ${options.token}`) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
      }
      let body: { subject?: string; workspaceId?: string; routeId?: string; roles?: string[] }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return Response.json({ error: 'bad_request' }, { status: 400 })
      }
      const subject = String(body.subject ?? '')
      const workspaceId = String(body.workspaceId ?? '')
      requests.push({
        subject,
        workspaceId,
        routeId: String(body.routeId ?? ''),
        roles: Array.isArray(body.roles) ? body.roles : [],
      })
      const entry = policy[subject]
      if (!entry) {
        return Response.json({ allow: false, reason: 'the subject does not exist' })
      }
      const resolved = entryOf(entry)
      if (resolved.workspaces.includes(workspaceId)) {
        return Response.json({ allow: true })
      }
      return Response.json({
        allow: false,
        reason: resolved.reason ?? 'the subject does not have the role of the workspace',
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port ?? 0}`,
    port: server.port ?? 0,
    requests,
    setPolicy: (next: AccessPolicy) => {
      policy = next
    },
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? '8090')
  let service: StartedAccessService
  try {
    service = await startAccessService({ port })
  } catch (error) {
    if (error instanceof FixtureInProductionError) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'the development access service must not run in production',
          error: error.message,
        })
      )
      process.exit(1)
    }
    throw error
  }
  console.log(
    JSON.stringify({ level: 'info', msg: 'shuttle access fixture started', port: service.port })
  )
  const shutdown = (): void => {
    void service.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
