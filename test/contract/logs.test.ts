import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './harness'

/**
 * The log of a request.
 *
 * The gateway decides who reaches what, so the log of a request has to say
 * who made it: a gateway whose log cannot name the caller cannot answer
 * "who used this workspace" with its own logs.
 *
 * The wording of the log is not a contract of the release — the names of
 * the functions and the wording of the logs are implementation details
 * (§16.1 of the specification) — but the **fields** that carry the identity
 * of the caller are what an operator reads the log for, and they are
 * proved here.
 */

/** The routes of the tests. */
function routes(context: { upstreamA: string }): unknown[] {
  return [
    {
      id: 'workspace-api',
      match: { host: 'workspace.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
    },
    {
      id: 'denied-api',
      match: { host: 'denied.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamA,
      auth: { mode: 'jwt', workspace: { param: 'workspaceId', requireUuid: true } },
    },
  ]
}

/** The lines the gateway wrote. */
class LogLines {
  readonly lines: string[] = []

  readonly sink = (line: string): void => {
    this.lines.push(line)
  }

  /** The lines that carry the given message. */
  of(message: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const line of this.lines) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.msg === message) out.push(parsed)
    }
    return out
  }

  /** The last line that carries the given message. */
  last(message: string): Record<string, unknown> | undefined {
    return this.of(message).at(-1)
  }
}

describe('the log of a request', () => {
  let harness: Harness
  let logs: LogLines

  beforeAll(async () => {
    logs = new LogLines()
    harness = await createHarness({
      routes,
      logSink: logs.sink,
      // The log of a request is written at the level `info`, so the level
      // of the tests has to carry it.
      env: { SHUTTLE_LOG_LEVEL: 'info' },
      // The subject of the tests may use every workspace, and no other
      // subject may use one: the denial of the tests is a policy.
      policy: {
        'user-alice': ['*'],
        'alice@shuttle.test': ['*'],
      },
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the log of a proxied request names the caller and the workspace', async () => {
    const token = await harness.token({ subject: 'user-alice' })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'workspace.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)

    const line = logs.last('request proxied')
    expect(line).toBeDefined()
    // The caller and the workspace: without them the log of a request
    // cannot be tied to a caller.
    expect(line?.subject).toBe('user-alice')
    expect(line?.workspaceId).toBe(WORKSPACE_ID)
    expect(line?.routeId).toBe('workspace-api')
  })

  test('the log of a denial names the caller that was denied', async () => {
    const token = await harness.token({ subject: 'user-bob' })
    const response = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'denied.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(403)

    const line = logs.last('workspace access denied')
    expect(line).toBeDefined()
    // The subject of the denial: an operator that reads a denial without
    // the caller cannot tell an accident from an attempt.
    expect(line?.subject).toBe('user-bob')
    expect(line?.workspaceId).toBe(WORKSPACE_ID)
  })

  test('the log never carries a credential of the caller', async () => {
    const token = await harness.token({ subject: 'user-alice' })
    await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/`, {
      headers: { host: 'workspace.shuttle.test', authorization: `Bearer ${token}` },
    })
    // The bearer token of the caller is a credential: it never reaches the
    // log stream.
    for (const line of logs.lines) {
      expect(line).not.toContain(token)
    }
  })
})
