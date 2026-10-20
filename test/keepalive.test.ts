import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WebSocket as ClientWebSocket } from 'ws'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The keepalive of the websockets.
 *
 * The gateway pings the client and the upstream. The ping keeps the
 * connection alive through the proxies in between, and it tells the gateway
 * that the other side is still there: a connection that does not answer the
 * pings is closed, so the registry does not count the connections of the
 * clients that went away without a close frame.
 *
 * The client of the tests below is a raw socket: it performs the handshake
 * and never answers a ping, which is what a client that hung up without a
 * close frame looks like.
 */
let harness: Harness

beforeAll(async () => {
  harness = await createHarness({
    websocketPingIntervalMs: 200,
    websocketPongTimeoutMs: 600,
  })
})

afterAll(async () => {
  await harness.stop()
})

interface RawConnection {
  /** The status of the handshake. */
  status: number
  /** The number of ping frames the gateway sent. */
  pings: number
  /** Resolves when the gateway closed the connection. */
  closed: Promise<boolean>
}

/**
 * Opens a websocket with a raw socket and never answers a ping.
 */
async function connectWithoutAnswering(token: string): Promise<RawConnection> {
  const port = new URL(harness.gatewayUrl).port
  let buffer = ''
  let scanned = 0
  let pings = 0
  let status = 0
  let closed = false
  let resolveClosed: (value: boolean) => void = () => {}
  const closedPromise = new Promise<boolean>((resolve) => {
    resolveClosed = resolve
  })

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(port),
    socket: {
      data(_socket, data) {
        buffer += data.toString('binary')
        if (status === 0) {
          const separator = buffer.indexOf('\r\n\r\n')
          if (separator === -1) return
          const head = buffer.slice(0, separator)
          status = head.startsWith('HTTP/1.1 101') ? 101 : Number(/HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0)
          buffer = buffer.slice(separator + 4)
          scanned = 0
        }
        // A ping frame is 0x89 when it is not masked (the frames of the
        // server are never masked).
        for (let index = scanned; index < buffer.length; index++) {
          if (buffer.charCodeAt(index) === 0x89) pings += 1
        }
        scanned = buffer.length
      },
      close() {
        if (!closed) {
          closed = true
          resolveClosed(true)
        }
      },
      error() {
        if (!closed) {
          closed = true
          resolveClosed(true)
        }
      },
    },
  })

  // The nonce of the handshake has to be sixteen bytes, as the protocol
  // says.
  const key = Buffer.from('the sample nonce').toString('base64')
  socket.write(
    `GET /ws/${WORKSPACE_ID}/ws HTTP/1.1\r\n` +
      `Host: api.shuttle.test\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Authorization: Bearer ${token}\r\n` +
      `\r\n`
  )

  // The handshake and the first pings need a moment.
  await Bun.sleep(300)
  return {
    get status() {
      return status
    },
    get pings() {
      return pings
    },
    closed: closedPromise,
  }
}

describe('the keepalive of the websockets', () => {
  test('a client that does not answer the pings is closed', async () => {
    const token = await harness.token()
    const connection = await connectWithoutAnswering(token)
    expect(connection.status).toBe(101)
    // The gateway pinged the client, the client did not answer.
    expect(connection.pings).toBeGreaterThan(0)
    // The gateway gave up on the connection and closed it.
    const closed = await Promise.race([
      connection.closed,
      Bun.sleep(5_000).then(() => false),
    ])
    expect(closed).toBe(true)
  })

  test('a client that answers the pings keeps its connection', async () => {
    const token = await harness.token()
    const port = new URL(harness.gatewayUrl).port
    const socket = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    // The keepalive pings the client several times, the client answers and
    // the connection survives.
    await Bun.sleep(1_500)
    expect(socket.readyState).toBe(ClientWebSocket.OPEN)
    socket.close()
  })
})
