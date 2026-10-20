import { describe, expect, test } from 'bun:test'
import { WebSocket as ClientWebSocket } from 'ws'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

function routes(context: { upstreamA: string; upstreamB: string }): unknown[] {
  return [
    {
      id: 'public-site',
      match: { host: 'public.shuttle.test', path: '/' },
      upstream: context.upstreamA,
      auth: { mode: 'none' },
    },
    {
      id: 'workspace-api',
      match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamB,
      auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
      websocket: true,
    },
  ]
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness({ routes })
  try {
    await run(harness)
  } finally {
    await harness.stop()
  }
}

describe('the shutdown', () => {
  test('finishes while a websocket is open', async () => {
    await withHarness(async (harness) => {
      const login = await harness.login()
      const socket = new ClientWebSocket(
        `ws://localhost:${new URL(harness.gatewayUrl).port}/ws/${WORKSPACE_ID}/ws`,
        { headers: { host: 'api.shuttle.test', cookie: login.cookie } }
      )
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })

      // A websocket never finishes on its own, so the shutdown has to close
      // it instead of waiting for the connection to end.
      const started = Date.now()
      const outcome = await Promise.race([
        harness.servers.stop().then(() => 'stopped'),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 10_000)),
      ])
      expect(outcome).toBe('stopped')
      expect(Date.now() - started).toBeLessThan(10_000)

      // The client is told that the gateway is going away.
      const closed = await new Promise<number>((resolve) => {
        socket.once('close', (code) => resolve(code))
        setTimeout(() => resolve(-1), 5_000)
      })
      expect(closed).toBeGreaterThanOrEqual(1000)

      try {
        socket.close()
      } catch {
        /* the socket is already closed */
      }
    })
  })

  test('a request that is in flight is given time to finish', async () => {
    await withHarness(async (harness) => {
      const request = fetch(`${harness.gatewayUrl}/slow?ms=500`, {
        headers: { host: 'public.shuttle.test' },
      })
      await Bun.sleep(50)
      const stopping = harness.servers.stop()
      // The request is not cut off, the shutdown waits for it.
      const response = await request
      expect(response.status).toBe(200)
      const body = (await response.json()) as { service: string }
      expect(body.service).toBe('upstream-a')
      await stopping
    })
  })
})
