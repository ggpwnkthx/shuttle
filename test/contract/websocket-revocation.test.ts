import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WebSocket } from 'ws'
import { createHarness, type Harness } from './harness'

/**
 * The revocation of the access of an open websocket.
 *
 * A connection is authorized when it is opened. A connection that stays
 * open for hours has to be authorized again, otherwise the access it was
 * opened with is the access it keeps for ever.
 */

/** The port of the gateway, as a number. */
function portOf(url: string): number {
  return Number(new URL(url).port)
}

/**
 * Opens a websocket and waits for the close of the connection.
 *
 * The close code is the answer of the test: `1008` is the policy
 * violation, the code the gateway uses when the access of the connection
 * was revoked.
 */
function openUntilClosed(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('the connection was not closed in time'))
    }, timeoutMs)
    socket.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString() })
    })
    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(new Error(`the connection failed: ${error.message}`))
    })
  })
}

describe('the revocation of an open websocket', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: { SHUTTLE_WS_REVALIDATE_INTERVAL_MS: '200' },
      routes: (context) => [
        {
          // The host is a wildcard: the websocket client of a test cannot
          // set the host of the request.
          id: 'workspace-socket',
          match: { host: '*', path: '/ws/{workspaceId}/' },
          upstream: context.upstreamB,
          auth: {
            mode: 'any',
            workspace: { param: 'workspaceId', requireUuid: true },
          },
          websocket: true,
        },
      ],
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a connection whose access is revoked is closed', async () => {
    const login = await harness.login()
    const workspaceId = '11111111-1111-4111-8111-111111111111'
    const port = portOf(harness.gatewayUrl)
    const closed = openUntilClosed(
      `ws://localhost:${port}/ws/${workspaceId}/`,
      { cookie: login.cookie, origin: `http://localhost:${port}` },
      10_000
    )

    // Give the connection a moment to be established, then revoke the
    // access of the caller.
    await new Promise((resolve) => setTimeout(resolve, 300))
    harness.access.setPolicy({})

    const outcome = await closed
    expect(outcome.code).toBe(1008)
  })
})
