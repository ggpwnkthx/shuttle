#!/usr/bin/env bun
/**
 * A raw http server for the transport tests.
 *
 * The fixtures that answer with a well formed http response cannot express
 * everything the specification talks about: an interim response (`103 Early
 * Hints`), a protocol switch (`101 Switching Protocols`), a response whose
 * headers arrive very late or a connection that is dropped in the middle of
 * a body. This server writes the bytes itself, so a test can script the
 * exact wire behaviour it wants to observe.
 */

import { connect } from 'node:net'

export interface RawRequest {
  /** The head of the request, as it arrived. */
  head: string
  method: string
  path: string
  headers: Record<string, string>
}

export interface RawConnection {
  socket: {
    write: (data: string | Uint8Array) => number
    end: (data?: string | Uint8Array) => void
    destroy: () => void
  }
  request: RawRequest
}
export type RawHandler = (connection: RawConnection) => void | Promise<void>

export interface StartedRawServer {
  port: number
  url: string
  stop: () => Promise<void>
}

/** Parses the head of a request. */
function parseHead(head: string): RawRequest {
  const lines = head.split('\r\n')
  const [requestLine = ''] = lines
  const parts = requestLine.split(' ')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return { head, method: parts[0] ?? 'GET', path: parts[1] ?? '/', headers }
}

/**
 * Starts a server that writes the answer itself.
 *
 * The handler is called once the head of the request arrived; it owns the
 * socket from then on.
 */
export async function startRawHttpServer(handler: RawHandler): Promise<StartedRawServer> {
  const listener = Bun.listen({
    port: 0,
    hostname: '127.0.0.1',
    socket: {
      data(socket, data) {
        const state = socket as unknown as { buffer: string; ready: boolean }
        state.buffer ??= ''
        if (state.ready) return
        state.buffer += Buffer.from(data).toString('utf8')
        const end = state.buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        state.ready = true
        const request = parseHead(state.buffer.slice(0, end))
        void handler({ socket: socket as unknown as RawConnection['socket'], request })
      },
    },
  })

  return {
    port: listener.port,
    url: `http://127.0.0.1:${listener.port}`,
    stop: async () => {
      await listener.stop(true)
    },
  }
}

/** A well formed http answer, written byte by byte. */
export function httpResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): string {
  const lines = [`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Status'}`]
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`)
  }
  if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  lines.push('Connection: close')
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

export interface RawResponse {
  /** The head of the answer, as it arrived. */
  head: string
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Sends a request over a socket and reads the answer.
 *
 * The answer of a websocket handshake is only visible on the wire: neither a
 * browser nor the websocket client of the runtime exposes the headers of the
 * `101` answer, so a test that wants to assert on them has to read the
 * socket itself.
 */
export async function rawRequest(options: {
  port: number
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<RawResponse> {
  const method = options.method ?? 'GET'
  const path = options.path ?? '/'
  const headers = options.headers ?? {}
  const lines = [`${method} ${path} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`)
  }
  if (options.body) lines.push(`Content-Length: ${Buffer.byteLength(options.body)}`)
  lines.push('Connection: close')
  const request = `${lines.join('\r\n')}\r\n\r\n${options.body ?? ''}`

  return await new Promise<RawResponse>((resolve, reject) => {
    const socket = connect({ port: options.port, host: '127.0.0.1' }, () => {
      socket.write(request)
    })
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('the raw request timed out'))
    }, options.timeoutMs ?? 5_000)

    const finish = (text: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const end = text.indexOf('\r\n\r\n')
      const head = end === -1 ? text : text.slice(0, end)
      const body = end === -1 ? '' : text.slice(end + 4)
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? '0')
      const parsed: Record<string, string> = {}
      for (const line of head.split('\r\n').slice(1)) {
        const index = line.indexOf(':')
        if (index === -1) continue
        parsed[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
      }
      socket.destroy()
      resolve({ head, status, headers: parsed, body })
    }

    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      // The answer is handed over as soon as the head arrived: the answer of
      // a websocket handshake never ends.
      if (text.includes('\r\n\r\n')) finish(text)
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    socket.on('close', () => {
      finish(Buffer.concat(chunks).toString('utf8'))
    })
  })
}
