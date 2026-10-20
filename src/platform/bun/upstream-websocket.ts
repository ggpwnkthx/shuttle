/**
 * The handshake with an upstream websocket.
 *
 * The gateway opens the connection to the upstream *before* it answers the
 * caller, so the caller learns the outcome of the handshake and the
 * subprotocol the upstream selected. The adapter therefore has to report
 * three outcomes apart: the handshake was accepted, the upstream refused it
 * with an http answer, or the connection failed.
 *
 * The refusal is a normal answer of an upstream: a service that requires an
 * authentication the gateway does not have answers `401` or `403`, and the
 * caller deserves to see it. The runtime of the websocket client of the
 * gateway reports it as an "unexpected response", with the status, the
 * headers and the body.
 */

import { WebSocket as NodeWebSocket } from 'ws'
import type {
  UpstreamHandshakeOutcome,
  UpstreamHandshakePort,
  UpstreamHandshakeRequest,
  UpstreamSocket,
  UpstreamSocketEvents,
  WebSocketMessage,
} from '../../domains/websockets'

/** The socket of the upstream, seen through the port of the domain. */
class WsUpstreamSocket implements UpstreamSocket {
  #socket: NodeWebSocket

  constructor(socket: NodeWebSocket) {
    this.#socket = socket
  }

  send(message: WebSocketMessage): void {
    this.#socket.send(message as string | Buffer)
  }

  close(code?: number, reason?: string): void {
    if (this.#socket.readyState === NodeWebSocket.OPEN) {
      this.#socket.close(code, reason)
      return
    }
    this.#socket.terminate()
  }

  terminate(): void {
    this.#socket.terminate()
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount
  }

  on<E extends keyof UpstreamSocketEvents>(event: E, listener: UpstreamSocketEvents[E]): void {
    if (event === 'message') {
      this.#socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const payload = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer)
        ;(listener as (message: WebSocketMessage, isBinary: boolean) => void)(payload, isBinary)
      })
      return
    }
    if (event === 'close') {
      this.#socket.on('close', (code: number, reason: Buffer) => {
        ;(listener as (code: number, reason: string) => void)(code, reason?.toString() ?? '')
      })
      return
    }
    if (event === 'error') {
      this.#socket.on('error', (error: Error) => {
        ;(listener as (error: Error) => void)(error)
      })
      return
    }
    this.#socket.on('pong', () => {
      ;(listener as () => void)()
    })
  }

  ping(): void {
    this.#socket.ping()
  }
}

export class WsUpstreamHandshake implements UpstreamHandshakePort {
  async connect(request: UpstreamHandshakeRequest): Promise<UpstreamHandshakeOutcome> {
    return await new Promise<UpstreamHandshakeOutcome>((resolve) => {
      const socket = new NodeWebSocket(request.url, request.protocols, {
        headers: request.headers,
        handshakeTimeout: request.timeoutMs,
        // The compression of the two legs is negotiated separately: the
        // gateway terminates the compression of the caller leg, so a leg
        // that negotiates it on its own would send frames the other side
        // cannot read.
        perMessageDeflate: false,
      })

      let settled = false
      const settle = (outcome: UpstreamHandshakeOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        try {
          socket.terminate()
        } catch {
          /* the socket is already gone */
        }
        settle({
          kind: 'failed',
          reason: 'timeout',
          message: 'the upstream did not answer the handshake',
        })
      }, request.timeoutMs)

      // The socket keeps an error listener for its whole life: a connection
      // that failed must not raise an unhandled error event later on.
      socket.on('error', () => undefined)

      socket.once('open', () => {
        settle({
          kind: 'accepted',
          protocol: socket.protocol ?? '',
          headers: new Headers(),
          socket: new WsUpstreamSocket(socket),
        })
      })

      socket.once('unexpected-response', (_request, response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          settle({
            kind: 'refused',
            status: response.statusCode ?? 502,
            headers: new Headers(response.headers as Record<string, string>),
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })

      socket.once('error', (error: Error) => {
        settle({
          kind: 'failed',
          reason: 'network',
          message: error.message,
        })
      })
    })
  }
}
