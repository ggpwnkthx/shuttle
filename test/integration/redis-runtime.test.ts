import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readEnv } from '../../src/runtime/env'
import { createRuntime, type GatewayRuntime } from '../../src/runtime/composition'

/**
 * The shared state of a deployment with several replicas.
 *
 * The replicas share the sessions and the cached decisions: a caller that
 * signs in on one replica is signed in on the other one, and the access
 * service is asked once and not once per replica.
 */
const url = process.env.SHUTTLE_TEST_REDIS_URL
const describeRedis = url ? describe : describe.skip

describeRedis('a deployment with several replicas', () => {
  let first: GatewayRuntime
  let second: GatewayRuntime

  const settings = (port: number) =>
    readEnv({
      SHUTTLE_CONFIG: '/tmp/shuttle-test-routes.json',
      SHUTTLE_GATEWAY_HOST: '127.0.0.1',
      SHUTTLE_GATEWAY_PORT: String(port),
      SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1',
      SHUTTLE_OIDC_CLIENT_ID: 'shuttle',
      SHUTTLE_OIDC_CLIENT_SECRET: 'shuttle-test-secret',
      SHUTTLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:1/auth/callback',
      SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
      SHUTTLE_ACCESS_URL: 'http://127.0.0.1:1',
      SHUTTLE_SESSION_SECRET: 'shared-session-secret',
      SHUTTLE_SESSION_URL: url!,
      SHUTTLE_SHARED_STATE_URL: url!,
      SHUTTLE_SESSION_KEY_PREFIX: 'shuttle-test',
      SHUTTLE_SHARED_STATE_KEY_PREFIX: 'shuttle-test',
      SHUTTLE_LOG_LEVEL: 'error',
    })

  beforeAll(async () => {
    first = await createRuntime(settings(0))
    second = await createRuntime(settings(0))
  })

  afterAll(async () => {
    await first?.listener.stop(true)
    await second?.listener.stop(true)
    await first?.close()
    await second?.close()
  })

  test('a session of a replica is the session of the other one', async () => {
    const created = await first.auth.sessions.create({ subject: 'user-1', roles: ['admin'] })
    const read = await second.auth.sessions.get(created.id)
    expect(read?.subject).toBe('user-1')
    expect(read?.roles).toEqual(['admin'])

    // The logout of a replica ends the session for the other one as well.
    await first.auth.sessions.destroy(created.id)
    expect(await second.auth.sessions.get(created.id)).toBeNull()
  })

  test('the decision of the access service is shared by the replicas', async () => {
    const calls: number[] = []
    const transport = {
      async post() {
        calls.push(1)
        return { status: 200, body: '{"allow":true}' }
      },
    }
    // The cache of the decisions lives in the shared state: the replicas
    // read the decision of each other.
    const { RedisDecisionCache } = await import('../../src/domains/workspace-access/adapters')
    const { createRedisClient, withRetries } = await import('../../src/platform/redis')
    const client = withRetries(createRedisClient({ url: url! }))
    const shared = new RedisDecisionCache({ client, keyPrefix: 'shuttle-test-decisions' })
    const { AccessClient } = await import('../../src/domains/workspace-access')
    const one = new AccessClient({
      baseUrl: 'http://access.test',
      transport,
      cache: shared,
      cacheTtlMs: 60_000,
    })
    const other = new AccessClient({
      baseUrl: 'http://access.test',
      transport,
      cache: shared,
      cacheTtlMs: 60_000,
    })
    // The key of a decision is unique: a decision that a previous run left
    // in the shared state would be read as a cached one.
    const request = {
      subject: 'user-1',
      workspaceId: `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      routeId: 'workspace-api',
      roles: ['admin'],
    }
    expect((await one.decide(request)).cached).toBe(false)
    // The second replica reads the decision of the first one: the access
    // service is asked once and not once per replica.
    expect((await other.decide(request)).cached).toBe(true)
    expect(calls.length).toBe(1)
  })
})
