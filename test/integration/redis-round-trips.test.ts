import { describe, expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { createRedisClient, type SharedStateClient } from '../../src/platform/redis'

/**
 * The round trips of the shared state.
 *
 * The gateway asks the server that holds the state the replicas share for
 * the windows of the limiters, for the session of the caller and for the
 * cached decisions. Every one of those is a round trip, and the
 * measurements of `docs/capacity.md` attribute the cost of the shared
 * state to the number of round trips.
 *
 * The three budgets of a request are independent, so they are counted at
 * the same time (`src/app/limits.ts`). This test proves what that buys:
 * the three commands reach the server **in one round trip**, because the
 * client of the `redis` package writes the commands that were queued in
 * the same tick in one go.
 *
 * The server of the test is a fake one: it speaks enough of the protocol
 * to answer the handshake and the commands, and it counts the reads it
 * receives. A read is a round trip.
 */

/** The commands a fake server received, and the reads they came in. */
interface FakeServer {
  url: string
  /** The number of reads that carried at least one command. */
  reads: () => number
  /** The names of the commands the server received. */
  commands: () => string[]
  /** Forgets what was received, so the handshake is not counted. */
  reset: () => void
  stop: () => Promise<void>
}

/** The answer of a `HELLO`, in the third version of the protocol. */
const HELLO_REPLY =
  '%7\r\n' +
  '$6\r\nserver\r\n$5\r\nredis\r\n' +
  '$7\r\nversion\r\n$5\r\n7.0.0\r\n' +
  '$5\r\nproto\r\n:3\r\n' +
  '$2\r\nid\r\n:1\r\n' +
  '$4\r\nmode\r\n$10\r\nstandalone\r\n' +
  '$4\r\nrole\r\n$6\r\nmaster\r\n' +
  '$7\r\nmodules\r\n*0\r\n'

/** The answer of a command of the limiter: allowed, one request, no wait. */
const EVAL_REPLY = '*3\r\n:1\r\n:1\r\n:0\r\n'

/** Parses the commands of a buffer of the protocol. */
function parse(buffer: string): { commands: string[]; rest: string } {
  const commands: string[] = []
  let rest = buffer
  while (rest.startsWith('*')) {
    const end = rest.indexOf('\r\n')
    if (end === -1) break
    const count = Number(rest.slice(1, end))
    let cursor = end + 2
    const parts: string[] = []
    let complete = true
    for (let index = 0; index < count; index++) {
      if (!rest.startsWith('$', cursor)) {
        complete = false
        break
      }
      const lengthEnd = rest.indexOf('\r\n', cursor)
      if (lengthEnd === -1) {
        complete = false
        break
      }
      const length = Number(rest.slice(cursor + 1, lengthEnd))
      const start = lengthEnd + 2
      const endOfValue = start + length
      if (rest.length < endOfValue + 2) {
        complete = false
        break
      }
      parts.push(rest.slice(start, endOfValue))
      cursor = endOfValue + 2
    }
    if (!complete) break
    commands.push(parts[0] ?? '')
    rest = rest.slice(cursor)
  }
  return { commands, rest }
}

/** Starts a server that answers the commands and counts the reads. */
async function startFakeServer(): Promise<FakeServer> {
  let reads = 0
  let commands: string[] = []
  const sockets = new Set<Socket>()

  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      reads += 1
      buffer += chunk.toString('utf8')
      const parsed = parse(buffer)
      buffer = parsed.rest
      for (const command of parsed.commands) {
        commands.push(command)
        if (command === 'HELLO') socket.write(HELLO_REPLY)
        else if (command === 'EVAL') socket.write(EVAL_REPLY)
        else socket.write('+OK\r\n')
      }
    })
    socket.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    url: `redis://127.0.0.1:${port}/0`,
    reads: () => reads,
    commands: () => [...commands],
    reset: () => {
      reads = 0
      commands = []
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Connects a client and waits for the handshake to be done. */
async function connectedClient(url: string): Promise<SharedStateClient> {
  const client = createRedisClient({ url })
  // The client connects in the background and the offline queue is
  // disabled: a command that is sent before the connection is established
  // fails right away. The test waits for the connection.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.ping()
      return client
    } catch {
      await Bun.sleep(20)
    }
  }
  throw new Error('the client did not connect to the server of the test')
}

describe('the round trips of the shared state', () => {
  test('three commands that are sent at the same time are one round trip', async () => {
    const server = await startFakeServer()
    try {
      const client = await connectedClient(server.url)
      server.reset()

      // The three budgets of a request, counted at the same time.
      await Promise.all([
        client.eval('return 1', 0, 'a'),
        client.eval('return 1', 0, 'b'),
        client.eval('return 1', 0, 'c'),
      ])

      expect(server.commands()).toEqual(['EVAL', 'EVAL', 'EVAL'])
      // The three commands reached the server in one read: one round trip.
      expect(server.reads()).toBe(1)
      await client.close()
    } finally {
      await server.stop()
    }
  })

  test('three commands that are sent one after the other are three round trips', async () => {
    const server = await startFakeServer()
    try {
      const client = await connectedClient(server.url)
      server.reset()

      await client.eval('return 1', 0, 'a')
      await client.eval('return 1', 0, 'b')
      await client.eval('return 1', 0, 'c')

      expect(server.commands()).toEqual(['EVAL', 'EVAL', 'EVAL'])
      expect(server.reads()).toBe(3)
      await client.close()
    } finally {
      await server.stop()
    }
  })
})
