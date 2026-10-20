import { describe, expect, test } from 'bun:test'
import { RedisSessionStore } from '../src/auth/session'

/**
 * A minimal RESP server.
 *
 * The session store talks to Redis through the client of Bun, so the tests
 * below exercise the real client over a real socket: the handshake, the
 * commands and the wire format are the ones a Redis server sees. The
 * server is not a Redis implementation, it only answers the handful of
 * commands the store uses.
 */
interface Entry {
  value: string
  expiresAt: number | null
}

class RespServer {
  #server: Bun.TCPSocketListener
  #entries = new Map<string, Entry>()
  #buffers = new Map<unknown, string>()

  constructor() {
    const options: Bun.TCPSocketListenOptions = {
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data: (socket, data) => {
          const buffer = (this.#buffers.get(socket) ?? '') + data.toString()
          const consumed = this.#handle(socket, buffer)
          this.#buffers.set(socket, consumed.rest)
        },
        close: (socket) => {
          this.#buffers.delete(socket)
        },
      },
    }
    this.#server = Bun.listen(options)
  }

  get port(): number {
    return this.#server.port
  }

  get url(): string {
    return `redis://127.0.0.1:${this.#server.port}`
  }

  stop(): void {
    this.#server.stop(true)
  }

  /** Handles the commands of the buffer and returns what is left over. */
  #handle(socket: { write: (data: string) => void }, buffer: string): { rest: string } {
    let rest = buffer
    for (;;) {
      const parsed = parseCommand(rest)
      if (!parsed) break
      rest = parsed.rest
      socket.write(this.#answer(parsed.command))
    }
    return { rest }
  }

  #answer(command: string[]): string {
    const name = (command[0] ?? '').toUpperCase()
    switch (name) {
      case 'HELLO':
        // An empty map: the client only needs the handshake to succeed.
        return '%0\r\n'
      case 'PING':
        return '+PONG\r\n'
      case 'SET': {
        const key = command[1] ?? ''
        const value = command[2] ?? ''
        let expiresAt: number | null = null
        const exIndex = command.findIndex((part) => part.toUpperCase() === 'EX')
        if (exIndex !== -1) {
          const seconds = Number(command[exIndex + 1])
          expiresAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : null
        }
        const pxIndex = command.findIndex((part) => part.toUpperCase() === 'PX')
        if (pxIndex !== -1) {
          const milliseconds = Number(command[pxIndex + 1])
          expiresAt = Number.isFinite(milliseconds) ? Date.now() + milliseconds : null
        }
        this.#entries.set(key, { value, expiresAt })
        return '+OK\r\n'
      }
      case 'GET': {
        const entry = this.#entries.get(command[1] ?? '')
        if (!entry) return '$-1\r\n'
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
          this.#entries.delete(command[1] ?? '')
          return '$-1\r\n'
        }
        return `$${Buffer.byteLength(entry.value)}\r\n${entry.value}\r\n`
      }
      case 'DEL': {
        let removed = 0
        for (const key of command.slice(1)) {
          if (this.#entries.delete(key)) removed += 1
        }
        return `:${removed}\r\n`
      }
      case 'INCR': {
        const key = command[1] ?? ''
        const entry = this.#entries.get(key)
        const current = entry ? Number(entry.value) : 0
        const next = String(current + 1)
        if (entry) {
          entry.value = next
        } else {
          this.#entries.set(key, { value: next, expiresAt: null })
        }
        return `:${current + 1}\r\n`
      }
      case 'PEXPIRE': {
        const key = command[1] ?? ''
        const entry = this.#entries.get(key)
        if (!entry) return ':0\r\n'
        entry.expiresAt = Date.now() + Number(command[2] ?? 0)
        return ':1\r\n'
      }
      case 'PX': {
        // A millisecond expiry on a key that was set before.
        const key = command[1] ?? ''
        const entry = this.#entries.get(key)
        if (!entry) return ':0\r\n'
        entry.expiresAt = Date.now() + Number(command[2] ?? 0)
        return ':1\r\n'
      }
      case 'QUIT':
        return '+OK\r\n'
      default:
        return `-ERR unknown command '${name}'\r\n`
    }
  }
}

/** Parses one RESP command, returns the command and the rest of the buffer. */
function parseCommand(buffer: string): { command: string[]; rest: string } | null {
  if (!buffer.startsWith('*')) return null
  const endOfHeader = buffer.indexOf('\r\n')
  if (endOfHeader === -1) return null
  const count = Number(buffer.slice(1, endOfHeader))
  if (!Number.isFinite(count)) return null

  const command: string[] = []
  let offset = endOfHeader + 2
  for (let i = 0; i < count; i++) {
    if (!buffer.startsWith('$', offset)) return null
    const endOfLength = buffer.indexOf('\r\n', offset)
    if (endOfLength === -1) return null
    const length = Number(buffer.slice(offset + 1, endOfLength))
    const start = endOfLength + 2
    const end = start + length
    if (buffer.length < end + 2) return null
    command.push(buffer.slice(start, end))
    offset = end + 2
  }
  return { command, rest: buffer.slice(offset) }
}

describe('the session store against a redis server', () => {
  test('a session survives a round trip over the wire', async () => {
    const server = new RespServer()
    const store = new RedisSessionStore({ url: server.url, keyPrefix: 'shuttle-test' })
    try {
      expect(await store.ping()).toBe(true)

      const created = await store.create({
        subject: 'user-alice',
        email: 'alice@shuttle.test',
        roles: ['admin'],
      })
      expect(created.id).toBeString()

      const read = await store.get(created.id)
      expect(read?.subject).toBe('user-alice')
      expect(read?.email).toBe('alice@shuttle.test')
      expect(read?.roles).toEqual(['admin'])

      await store.destroy(created.id)
      expect(await store.get(created.id)).toBeNull()
    } finally {
      await store.close()
      server.stop()
    }
  })

  test('the sessions of two subjects do not mix', async () => {
    const server = new RespServer()
    const store = new RedisSessionStore({ url: server.url, keyPrefix: 'shuttle-test' })
    try {
      const alice = await store.create({ subject: 'user-alice' })
      const bob = await store.create({ subject: 'user-bob' })
      expect((await store.get(alice.id))?.subject).toBe('user-alice')
      expect((await store.get(bob.id))?.subject).toBe('user-bob')
    } finally {
      await store.close()
      server.stop()
    }
  })

  test('a store that cannot be reached reports itself as unavailable', async () => {
    // Nothing listens on this port, the store has to fail instead of
    // pretending that the session exists.
    const store = new RedisSessionStore({
      url: 'redis://127.0.0.1:9',
      keyPrefix: 'shuttle-test',
    })
    expect(await store.ping()).toBe(false)
    await store.close()
  })
})
