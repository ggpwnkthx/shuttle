#!/usr/bin/env bun
/**
 * The access fixture: a stand in for the service that owns the workspaces.
 *
 * It answers the decision requests of the gateway with a static policy. The
 * gateway never decides access on its own, so this fixture is what the tests
 * and the development stack talk to.
 */
import { Hono } from 'hono'
import { assertFixtureAllowed, FixtureInProductionError } from './fixture-guard'

/**
 * The workspaces a subject may use.
 *
 * A plain list of workspace identifiers is the normal case. The object form
 * adds a custom denial reason, which is how a role based denial is simulated.
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

function entryOf(entry: AccessPolicyEntry): { workspaces: string[]; reason?: string } {
  return Array.isArray(entry) ? { workspaces: entry } : entry
}

export function createAccessService(options: AccessServiceOptions = {}) {
  // The fixture makes the authorization decisions with a static policy: it is
  // a stand in for a real access service, never one itself.
  assertFixtureAllowed('access service')
  const app = new Hono()
  const policy = options.policy ?? DEFAULT_POLICY

  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'shuttle-access-fixture' }))

  app.post('/v1/decisions', async (c) => {
    if (options.unavailable) {
      return c.json({ error: 'unavailable' }, 503)
    }
    if (options.token) {
      const authorization = c.req.header('authorization') ?? ''
      if (authorization !== `Bearer ${options.token}`) {
        return c.json({ error: 'unauthorized' }, 401)
      }
    }
    let body: { subject?: unknown; workspaceId?: unknown; routeId?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const subject = typeof body.subject === 'string' ? body.subject : ''
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (!subject || !workspaceId) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const entry = entryOf(policy[subject] ?? [])
    const allow = entry.workspaces.includes(workspaceId)
    return c.json({
      allow,
      reason: allow
        ? 'the subject is a member of the workspace'
        : (entry.reason ?? 'the subject is not a member of the workspace'),
    })
  })

  return app
}

export interface StartedAccessService {
  url: string
  stop: () => Promise<void>
}

export async function startAccessService(
  options: AccessServiceOptions = {}
): Promise<StartedAccessService> {
  const app = createAccessService(options)
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch: (request) => app.fetch(request),
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8090)
  const policy: AccessPolicy = process.env.ACCESS_POLICY
    ? (JSON.parse(process.env.ACCESS_POLICY) as AccessPolicy)
    : DEFAULT_POLICY

  let app: Hono
  try {
    app = createAccessService({
      policy,
      token: process.env.ACCESS_TOKEN,
      unavailable: process.env.ACCESS_UNAVAILABLE === 'true',
    })
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

  Bun.serve({
    port,
    hostname: process.env.HOST ?? '0.0.0.0',
    fetch: (request) => app.fetch(request),
  })

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'shuttle access fixture started',
      port,
      subjects: Object.keys(policy),
    })
  )
}
