import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WebSocket as ClientWebSocket } from 'ws'
import { createHarness, OTHER_WORKSPACE_ID, WORKSPACE_ID, type Harness } from './helpers/harness'

let harness: Harness

interface ConnectResult {
  socket?: ClientWebSocket
  status?: number
}

function connect(url: string, headers: Record<string, string>): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = new ClientWebSocket(url, { headers })
    socket.on('open', () => resolve({ socket }))
    socket.on('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode })
      socket.close()
    })
    socket.on('error', (error) => {
      if ((error as { message?: string }).message?.includes('Unexpected server response')) {
        resolve({ status: 0 })
        return
      }
      reject(error)
    })
  })
}

function nextMessage(socket: ClientWebSocket, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(data.toString())
    })
  })
}

beforeAll(async () => {
  harness = await createHarness({
    routes: ({ upstreamA, upstreamB }) => [
      {
        id: 'public-site',
        match: { host: 'public.shuttle.test', path: '/' },
        upstream: upstreamA,
        auth: { mode: 'none' },
      },
      {
        id: 'workspace-api',
        match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
        upstream: upstreamB,
        auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
        websocket: true,
      },
    ],
  })
})

afterAll(async () => {
  await harness.stop()
})

describe('websockets', () => {
  test('bridges messages between the client and the upstream', async () => {
    const login = await harness.login()
    const result = await connect(
      `ws://localhost:${new URL(harness.gatewayUrl).port}/ws/${WORKSPACE_ID}/ws`,
      { host: 'api.shuttle.test', cookie: login.cookie }
    )
    expect(result.socket).toBeDefined()
    const socket = result.socket!
    const open = await nextMessage(socket)
    expect(open).toContain('upstream-b')

    socket.send('hello gateway')
    const echoed = await nextMessage(socket)
    expect(echoed).toContain('hello gateway')
    socket.close()
  })

  test('refuses to upgrade an unauthenticated connection', async () => {
    const result = await connect(
      `ws://localhost:${new URL(harness.gatewayUrl).port}/ws/${WORKSPACE_ID}/ws`,
      { host: 'api.shuttle.test' }
    )
    expect(result.socket).toBeUndefined()
    expect(result.status).toBe(401)
  })

  test('refuses to upgrade a connection to a workspace the user cannot access', async () => {
    const login = await harness.login()
    const result = await connect(
      `ws://localhost:${new URL(harness.gatewayUrl).port}/ws/${OTHER_WORKSPACE_ID}/ws`,
      { host: 'api.shuttle.test', cookie: login.cookie }
    )
    expect(result.socket).toBeUndefined()
    expect(result.status).toBe(403)
  })

  test('refuses websockets on routes that do not allow them', async () => {
    const result = await connect(
      `ws://localhost:${new URL(harness.gatewayUrl).port}/anything`,
      { host: 'public.shuttle.test' }
    )
    expect(result.socket).toBeUndefined()
    expect(result.status).toBe(400)
  })

  test('counts the accepted connections', async () => {
    const login = await harness.login()
    const before = (await harness.runtime.metrics.totals()).websockets
    const result = await connect(
      `ws://localhost:${new URL(harness.gatewayUrl).port}/ws/${WORKSPACE_ID}/ws`,
      { host: 'api.shuttle.test', cookie: login.cookie }
    )
    const socket = result.socket!
    await nextMessage(socket)
    socket.close()
    await Bun.sleep(250)
    expect((await harness.runtime.metrics.totals()).websockets).toBe(before + 1)
  })

  test('confirms the subprotocol the upstream selected to the client', async () => {
    // The client and the upstream have to speak the same protocol. The
    // gateway opens the upstream connection before it answers the client, so
    // it knows the subprotocol the upstream selected.
    const login = await harness.login()
    const port = new URL(harness.gatewayUrl).port
    const socket = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, [
      'shuttle-test-protocol',
    ], { headers: { host: 'api.shuttle.test', cookie: login.cookie } })

    const protocol = await new Promise<string>((resolve, reject) => {
      socket.once('open', () => resolve(socket.protocol))
      socket.on('error', reject)
    })
    expect(protocol).toBe('shuttle-test-protocol')

    const open = await nextMessage(socket)
    expect(open).toContain('upstream-b')
    socket.close()
  })

  test('refuses the connection when the upstream is not available', async () => {
    // The upstream is connected before the client is answered, so a broken
    // upstream is a refused handshake instead of a connection that dies
    // right after it was accepted.
    await harness.upstreamB.stop()
    const login = await harness.login()
    const port = new URL(harness.gatewayUrl).port
    const result = await new Promise<number | undefined>((resolve) => {
      const socket = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
        headers: { host: 'api.shuttle.test', cookie: login.cookie },
      })
      socket.once('open', () => resolve(undefined))
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode)
        socket.close()
      })
      socket.on('error', () => resolve(undefined))
    })
    expect(result).toBe(502)
  })
})
