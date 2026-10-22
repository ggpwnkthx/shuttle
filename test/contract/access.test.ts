import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, METRICS_TOKEN, WORKSPACE_ID, type Harness } from './harness'

/**
 * The access service of the gateway.
 *
 * The gateway asks the access service about the workspace of a route, and
 * it may ask it about a route that names no workspace. It fails closed, and
 * it tells a denial and an outage apart.
 *
 * The grace of an outage is what keeps the traffic of a deployment flowing
 * while the access service is down: the last decision of the service is
 * served for a bounded time, and only when it allows the caller.
 */

/** The routes of the tests. */
function routes(context: { upstreamA: string; upstreamB: string }): unknown[] {
  return [
    {
      id: 'workspace-api',
      match: { host: 'workspace.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
    },
    {
      id: 'graceful-workspace-api',
      match: { host: 'graceful.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
      // The decision is old almost immediately, and the grace is long: a
      // decision that is too old is served while the service is down.
      accessCacheTtlMs: 1,
      accessStaleGraceMs: 60_000,
    },
    {
      id: 'strict-workspace-api',
      match: { host: 'strict.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
      // The lifetime of the decision is a millisecond and there is no
      // grace: an outage of the service is an outage.
      accessCacheTtlMs: 1,
    },
    {
      id: 'admin-api',
      match: { host: 'admin.shuttle.test', path: '/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt' },
      // The route names no workspace: the access service is asked about
      // the route itself.
      accessCheck: true,
    },
    {
      id: 'unchecked-api',
      match: { host: 'unchecked.shuttle.test', path: '/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt' },
    },
  ]
}

/** The metrics of the gateway. */
async function metrics(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.gatewayUrl}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  return await response.text()
}

/** The decisions of the graceful route that were served while the service was down. */
function staleCount(text: string): number {
  const match = /shuttle_access_stale_total\{route="graceful-workspace-api"\} (\d+)/.exec(text)
  return match ? Number(match[1]) : 0
}

/**
 * Asks the graceful route while the access service is down.
 *
 * The first request lets the service decide, so the cache holds a decision
 * that allows the caller. The decision is then older than its lifetime of a
 * millisecond, and inside the grace: the answer of the second request is
 * the one of the stale decision.
 */
async function requestDuringOutage(harness: Harness): Promise<Response> {
  const token = await harness.token()
  const first = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
    headers: { host: 'graceful.shuttle.test', authorization: `Bearer ${token}` },
  })
  expect(first.status).toBe(200)
  harness.access.setUnavailable(true)
  try {
    await Bun.sleep(10)
    return await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'graceful.shuttle.test', authorization: `Bearer ${token}` },
    })
  } finally {
    harness.access.setUnavailable(false)
  }
}

describe('the access service of the gateway', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      routes,
      // The subject of the tests may use every workspace, and the requests
      // that name no workspace as well.
      policy: {
        'user-alice': ['*'],
        'alice@shuttle.test': ['*'],
      },
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a route that names no workspace is not checked by default', async () => {
    const token = await harness.token()
    const before = harness.access.requests.length
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'unchecked.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    // The service was not asked: the route does not name a workspace and
    // does not ask for a check.
    expect(harness.access.requests.length - before).toBe(0)
  })

  test('a route that asks for a check is checked without a workspace', async () => {
    const token = await harness.token()
    const before = harness.access.requests.length
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'admin.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    // The service was asked, and the request named no workspace.
    expect(harness.access.requests.length - before).toBe(1)
    expect(harness.access.requests.at(-1)?.workspaceId).toBe('')
    expect(harness.access.requests.at(-1)?.routeId).toBe('admin-api')
  })

  test('a route that asks for a check is refused when the service denies it', async () => {
    // The policy of the fixture knows one subject: the caller of another
    // subject is denied by the service.
    const token = await harness.token({ subject: 'user-bob' })
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'admin.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('workspace_forbidden')
  })

  test('an outage of the service is a 503 when there is no grace', async () => {
    const token = await harness.token()
    // A decision that lets the request through, so the cache is warm.
    const first = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'strict.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(first.status).toBe(200)
    harness.access.setUnavailable(true)
    try {
      // The decision is older than its lifetime of a millisecond.
      await Bun.sleep(10)
      const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
        headers: { host: 'strict.shuttle.test', authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: string }
      expect(body.error).toBe('access_unavailable')
    } finally {
      harness.access.setUnavailable(false)
    }
  })

  test('a decision is served while the service is down when the grace allows it', async () => {
    const response = await requestDuringOutage(harness)
    expect(response.status).toBe(200)
  })

  test('a decision that was served while the service was down is counted', async () => {
    const before = staleCount(await metrics(harness))
    const response = await requestDuringOutage(harness)
    expect(response.status).toBe(200)
    expect(staleCount(await metrics(harness))).toBe(before + 1)
  })
})
