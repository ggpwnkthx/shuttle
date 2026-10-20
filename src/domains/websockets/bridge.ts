/**
 * The bridge between the two legs of a websocket connection.
 *
 * The gateway connects the caller and the upstream and relays the messages
 * between them. The bridge owns:
 *
 * - the buffer of the messages that wait for the other leg, bounded in
 *   bytes and in messages;
 * - the backpressure: a caller that does not read grows the queue of the
 *   process without limit, so the connection is closed when the queue is
 *   over the limit;
 * - the keepalive: the gateway pings both legs and closes a connection that
 *   does not answer.
 */

import type { ClientLeg, UpstreamSocket, WebSocketMessage } from './ports'

/** The close code of a normal end of a connection. */
export const CLOSE_NORMAL = 1000

/** The close code of a connection that is closed by the gateway. */
export const CLOSE_GOING_AWAY = 1001

/** The close code of a connection whose other side is too slow. */
export const CLOSE_TRY_AGAIN_LATER = 1013

/**
 * The maximum size of the reason of a close frame, in bytes.
 *
 * The protocol reserves 125 bytes for the code and the reason together, so
 * a reason may not be longer than 123 bytes. A reason that is longer is
 * refused by the other side, and a refused close frame leaves the
 * connection hanging.
 */
export const MAX_CLOSE_REASON_BYTES = 123

/** Truncates a close reason to the size the protocol allows. */
export function truncateCloseReason(reason: string | undefined | null): string {
  if (!reason) return ''
  const bytes = new TextEncoder().encode(reason)
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason
  // The reason is cut on a character boundary: half of a character would
  // not be a valid utf-8 string.
  let cut = reason
  while (cut.length > 0) {
    cut = cut.slice(0, -1)
    if (new TextEncoder().encode(cut).byteLength <= MAX_CLOSE_REASON_BYTES) return cut
  }
  return ''
}

/** The settings of a bridge. */
export interface BridgeOptions {
  /** The caller leg of the connection. */
  client: ClientLeg
  /** The upstream leg of the connection. */
  upstream: UpstreamSocket
  /** The number of bytes that may wait for the other leg. */
  maxBufferedBytes: number
  /** The number of messages that may wait for the other leg. */
  maxBufferedMessages: number
  /** The number of bytes that may be queued for a caller that does not read. */
  backpressureLimitBytes: number
  /** How often the gateway pings the legs, in milliseconds. 0 disables it. */
  pingIntervalMs: number
  /** How long a leg may stay silent, in milliseconds. */
  pongTimeoutMs: number
  /** Called when the connection is over. */
  onClose?: (code: number, reason: string) => void
  /** Called when a message could not be relayed. */
  onError?: (message: string) => void
}

export class WebSocketBridge {
  #client: ClientLeg
  #upstream: UpstreamSocket
  #options: BridgeOptions
  /** The messages that wait for the upstream. */
  #buffer: WebSocketMessage[] = []
  #bufferedBytes = 0
  #closed = false
  #keepalive: ReturnType<typeof setInterval> | undefined
  #lastPongAt = Date.now()
  #lastUpstreamPongAt = Date.now()

  constructor(options: BridgeOptions) {
    this.#options = options
    this.#client = options.client
    this.#upstream = options.upstream
  }

  /** True when the connection is over. */
  get closed(): boolean {
    return this.#closed
  }

  /** The number of bytes that wait for the upstream. */
  get bufferedBytes(): number {
    return this.#bufferedBytes
  }

  /** Starts the relay and the keepalive. */
  start(): void {
    this.#upstream.on('message', (message, isBinary) => {
      this.#relayToClient(message, isBinary)
    })
    this.#upstream.on('pong', () => {
      this.#lastUpstreamPongAt = Date.now()
    })
    this.#upstream.on('close', (code, reason) => {
      this.close(code >= 1000 && code <= 4999 ? code : CLOSE_NORMAL, reason)
    })
    this.#upstream.on('error', (error) => {
      this.#options.onError?.(`the upstream reported an error: ${error.message}`)
      this.close(CLOSE_GOING_AWAY, 'the upstream failed')
    })

    if (this.#options.pingIntervalMs > 0) {
      this.#keepalive = setInterval(() => this.#keepaliveTick(), this.#options.pingIntervalMs)
      this.#keepalive.unref?.()
    }
  }

  /** The message of the caller is relayed to the upstream. */
  relayToUpstream(message: WebSocketMessage): void {
    if (this.#closed) return
    const size = typeof message === 'string' ? message.length : message.byteLength

    // The upstream is slower than the caller: the queue of the upstream
    // grows and the messages of the caller wait in the queue of the
    // gateway. The queue is bounded, a connection that exceeds it is closed
    // instead of growing the memory of the process.
    if (this.#upstream.bufferedAmount > this.#options.backpressureLimitBytes) {
      this.#options.onError?.('the upstream is too slow')
      this.close(CLOSE_TRY_AGAIN_LATER, 'the upstream is too slow')
      return
    }

    if (this.#upstream.bufferedAmount > 0) {
      // The upstream is behind: the message waits for it.
      if (
        this.#buffer.length >= this.#options.maxBufferedMessages ||
        this.#bufferedBytes + size > this.#options.maxBufferedBytes
      ) {
        this.#options.onError?.('the buffer of the connection is full')
        this.close(CLOSE_TRY_AGAIN_LATER, 'buffer limit exceeded')
        return
      }
      this.#buffer.push(message)
      this.#bufferedBytes += size
      return
    }

    // The upstream caught up: the messages that waited for it go first.
    this.#flush()
    try {
      this.#upstream.send(message)
    } catch (error) {
      this.#options.onError?.(`the message could not be sent to the upstream: ${String(error)}`)
    }
  }

  /** The caller answered a ping of the gateway. */
  notePong(): void {
    this.#lastPongAt = Date.now()
  }

  /** The caller caught up with the messages of the gateway. */
  noteDrain(): void {
    // The counter of the slow sends starts again.
  }

  /** Closes the connection and both of its legs. */
  close(code: number = CLOSE_NORMAL, reason: string = ''): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#keepalive) {
      clearInterval(this.#keepalive)
      this.#keepalive = undefined
    }
    this.#buffer = []
    this.#bufferedBytes = 0
    try {
      this.#upstream.close(code, truncateCloseReason(reason))
    } catch {
      try {
        this.#upstream.terminate()
      } catch {
        /* the connection is already gone */
      }
    }
    try {
      this.#client.close(code, truncateCloseReason(reason))
    } catch {
      /* the connection is already gone */
    }
    this.#options.onClose?.(code, reason)
  }

  /** Sends the messages that wait for the upstream. */
  #flush(): void {
    if (this.#closed) return
    for (const message of this.#buffer) {
      try {
        this.#upstream.send(message)
      } catch (error) {
        this.#options.onError?.(`the message could not be sent to the upstream: ${String(error)}`)
        break
      }
    }
    this.#buffer = []
    this.#bufferedBytes = 0
  }

  /** Relays a message of the upstream to the caller. */
  #relayToClient(message: WebSocketMessage, _isBinary: boolean): void {
    if (this.#closed) return
    try {
      const status = this.#client.send(message)
      // The runtime reports the state of the queue: a negative value means
      // the caller is slower than the upstream, a zero means the message was
      // dropped. A caller that does not read grows the queue of the process
      // without limit, so the connection is closed instead.
      if (status === 0) {
        this.#options.onError?.('the message to the caller was dropped')
        this.close(CLOSE_TRY_AGAIN_LATER, 'the client is too slow')
        return
      }
      if (status < 0 && this.#client.bufferedAmount > this.#options.backpressureLimitBytes) {
        this.#options.onError?.('the caller does not read')
        this.close(CLOSE_TRY_AGAIN_LATER, 'the client is too slow')
      }
    } catch (error) {
      this.#options.onError?.(`the message could not be sent to the caller: ${String(error)}`)
    }
  }

  /**
   * The keepalive of the connection.
   *
   * The gateway pings both legs: the ping keeps the connection alive
   * through the proxies in between and it tells the gateway that the other
   * side is still there. A connection that does not answer is closed, so
   * the registry does not count the connections of the clients that went
   * away without a close frame.
   */
  #keepaliveTick(): void {
    if (this.#closed) return
    const now = Date.now()
    try {
      this.#client.ping()
    } catch {
      /* the connection is already gone */
    }
    try {
      this.#upstream.ping()
    } catch {
      /* the connection is already gone */
    }
    if (now - this.#lastPongAt > this.#options.pongTimeoutMs) {
      this.#options.onError?.('the caller did not answer')
      this.close(CLOSE_GOING_AWAY, 'the client did not answer')
      return
    }
    if (now - this.#lastUpstreamPongAt > this.#options.pongTimeoutMs) {
      this.#options.onError?.('the upstream did not answer')
      this.close(CLOSE_GOING_AWAY, 'the upstream did not answer')
    }
  }
}
