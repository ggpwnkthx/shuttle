import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './harness'

/**
 * The breaker of the access service.
 *
 * The access service is on the path of every request of a route that
 * names a workspace. A service that is down does not only refuse the
 * requests: it makes them **slow**, because every request waits for the
 * budget of the call before it is answered. The outage amplifies itself:
 * the slower gateway falls further behind.
 *
 * The breaker stops the calls while the service is failing. It only
 * refuses, so it cannot let a caller in that the service would not have
 * let in.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    // The breaker opens after two failures. The cooldown is short, so the
    // test can watch the service being called again.
    env: {
      SHUTTLE_ACCESS_BREAKER_FAILURES: '2',
      SHUTTLE_ACCESS_BREAKER_COOLDOWN_MS: '200',
    },
    routes: (context) => [
      {
        id: 'workspace-api',
        match: { host: 'workspace.shuttle.test', path: '/ws/{workspaceId}/' },
        upstream: context.upstreamA,
        auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
        // The decision is not cached: every request asks the service.
        accessCacheTtlMs: 0,
      },
    ],
    policy: { 'user-alice': ['*'], 'alice@shuttle.test': ['*'] },
  })
})

afterAll(async () => {
  await harness.stop()
})

/** Asks the route of the tests. */
async function ask(harness: Harness): Promise<Response> {
  const token = await harness.token()
  return await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
    headers: { host: 'workspace.shuttle.test', authorization: `Bearer ${token}` },
  })
}

describe('the breaker of the access service', () => {
  test('the service is not called any more while the breaker is open', async () => {
    harness.access.setUnavailable(true)
    try {
      // The first two failures open the breaker.
      expect((await ask(harness)).status).toBe(503)
      expect((await ask(harness)).status).toBe(503)
      const calls = harness.access.calls
      // The next request is refused without a call: the service is not
      // asked at all while the breaker is open.
      expect((await ask(harness)).status).toBe(503)
      expect(harness.access.calls).toBe(calls)
    } finally {
      harness.access.setUnavailable(false)
    }
  })

  test('the service is called again after the cooldown', async () => {
    // The cooldown is over: the breaker lets one call through, and the
    // service answers, so the traffic of the deployment flows again.
    await Bun.sleep(300)
    const calls = harness.access.calls
    expect((await ask(harness)).status).toBe(200)
    expect(harness.access.calls).toBeGreaterThan(calls)
  })
})
