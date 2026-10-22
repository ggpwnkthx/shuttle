import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, METRICS_TOKEN, WORKSPACE_ID, type Harness } from './harness'

/**
 * The reason of a denial.
 *
 * The access service sends the reason of a denial twice: as free text, for
 * the log and for the operator, and as a **code**, for the metric. The
 * gateway counts the code and never the text: a service that rewords its
 * reason must not silently change the metric of the gateway.
 *
 * A service that sends no code is counted as `access_denied`, the
 * category every denial belongs to.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    routes: (context) => [
      {
        id: 'workspace-api',
        match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
        upstream: context.upstreamA,
        auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
      },
    ],
    policy: {
      'user-alice': ['*'],
      'alice@shuttle.test': ['*'],
      // The subject is denied for a role it does not have: the service
      // sends the code `missing_role`.
      'user-without-role': {
        workspaces: [],
        reason: 'the subject does not have the role of the workspace',
      },
    },
  })
})

afterAll(async () => {
  await harness.stop()
})

/** The metrics of the gateway, by name and by reason. */
async function readMetrics(): Promise<Map<string, number>> {
  const response = await fetch(`${harness.gatewayUrl}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  const text = await response.text()
  const values = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+)(\{[^}]*\})? ([0-9.]+)$/.exec(line)
    if (!match) continue
    const name = match[1]!
    const labels = match[2] ?? ''
    const reason = /reason="([^"]+)"/.exec(labels)?.[1]
    const key = reason ? `${name}{reason="${reason}"}` : name
    values.set(key, (values.get(key) ?? 0) + Number(match[3]))
  }
  return values
}

describe('the reason of a denial', () => {
  test('the code of the reason is what the metric counts', async () => {
    const before = await readMetrics()
    const token = await harness.idp!.mintAccessToken({ subject: 'user-without-role' })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)
    const after = await readMetrics()
    // The denial is counted as a missing role, because the service said
    // so with its code.
    expect(after.get('shuttle_auth_failures_total{reason="missing_role"}')).toBe(
      (before.get('shuttle_auth_failures_total{reason="missing_role"}') ?? 0) + 1
    )
  })

  test('a denial that carries no code is counted as a denial', async () => {
    const before = await readMetrics()
    // A subject the service does not know: the service sends the code
    // `access_denied`.
    const token = await harness.idp!.mintAccessToken({ subject: 'user-nobody-knows' })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)
    const after = await readMetrics()
    expect(after.get('shuttle_auth_failures_total{reason="access_denied"}')).toBe(
      (before.get('shuttle_auth_failures_total{reason="access_denied"}') ?? 0) + 1
    )
  })
})
