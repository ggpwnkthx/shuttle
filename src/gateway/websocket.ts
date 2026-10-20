import type { ServerWebSocket } from 'bun'
import { WebSocket as UpstreamWebSocket } from 'ws'
import type { Logger } from '../log/logger'

export interface WebSocketContext {
  routeId: string
  upstreamUrl: string
  /** Headers forwarded to the upstream during the handshake. */
  headers: Record<string, string>
  requestId: string
  maxBufferedBytes: number
  maxBufferedMessages: number
  /**
   * The upstream connection, when it was opened before the client handshake
   * was answered. The gateway opens it first, so it can mirror the
   * negotiated subprotocol to the client.
   */
  upstream?: UpstreamWebSocket
  /** The subprotocol the upstream selected, empty when it selected none. */
  protocol?: string
  buffer: (string | Uint8Array)[]
  bufferedBytes: number
  closed: boolean
  /** The moment the client answered the last ping of the gateway. */
  lastPongAt: number
  /** The moment the upstream answered the last ping of the gateway. */
  lastUpstreamPongAt: number
  /** The moment the connection was opened. */
  openedAt: number
  /** The number of consecutive sends the client was too slow for. */
  backpressure: number
}

export interface WebSocketEvent {
  type: 'open' | 'close' | 'error'
  routeId: string
  requestId: string
  bytes?: number
  error?: string
  code?: number
}

export interface WebSocketHandlerOptions {
  logger: Logger
  /** The registry that keeps track of the open connections. */
  registry: WebSocketRegistry
  /**
   * How often the gateway pings the open connections, in milliseconds.
   *
   * A ping keeps the connection of the client and of the upstream alive
   * through the proxies in between and it tells the gateway that the other
   * side is still there. A value of zero disables the keepalive.
   */
  pingIntervalMs?: number
  /**
   * How long a connection may stay silent before it is closed, in
   * milliseconds. It is a multiple of the ping interval.
   */
  pongTimeoutMs?: number
  onEvent?: (event: WebSocketEvent) => void
}

const CLOSE_NORMAL = 1000
const CLOSE_GOING_AWAY = 1001
const CLOSE_TRY_AGAIN_LATER = 1013

/**
 * The number of consecutive sends the client was too slow for before the
 * connection is closed.
 *
 * A single slow send is normal, a client that is permanently slower than
 * the upstream is a problem: the queue of the process would grow without
 * limit.
 */
const MAX_CONSECUTIVE_BACKPRESSURE = 8

/**
 * The maximum size of the reason of a close frame, in bytes.
 *
 * The protocol reserves 125 bytes for the code and the reason together, so
 * a reason may not be longer than 123 bytes. A reason that is longer is
 * refused by the other side, and a refused close frame leaves the
 * connection hanging.
 */
const MAX_CLOSE_REASON_BYTES = 123

/** Truncates a close reason to the size the protocol allows. */
export function truncateCloseReason(reason: string | undefined | null): string {
  if (!reason) return ''
  const bytes = new TextEncoder().encode(reason)
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason
  // The reason is cut on a character boundary: a half of a character would
  // not be a valid utf-8 string.
  let cut = reason
  while (cut.length > 0) {
    cut = cut.slice(0, -1)
    if (new TextEncoder().encode(cut).byteLength <= MAX_CLOSE_REASON_BYTES) return cut
  }
  return ''
}

/**
 * The registry of the websocket connections.
 *
 * It knows how many connections are open and how many are on their way, so
 * the gateway can refuse a handshake when the limit is reached instead of
 * letting the process run out of memory.
 */
export class WebSocketRegistry {
  readonly maxConnections: number
  #connections = new Set<ServerWebSocket<WebSocketContext>>()
  /** The connections whose upstream was opened but whose client is not in yet. */
  #pending = 0

  constructor(maxConnections: number) {
    this.maxConnections = maxConnections
  }

  /** The number of connections that occupy a slot. */
  get connectionCount(): number {
    return this.#connections.size + this.#pending
  }

  /**
   * Reserves a slot for a connection that is about to be established.
   *
   * Returns false when the limit is reached. A limit of zero means "no
   * limit".
   */
  reserve(): boolean {
    if (this.maxConnections > 0 && this.connectionCount >= this.maxConnections) return false
    this.#pending += 1
    return true
  }

  /** Gives the reserved slot back, when the handshake did not happen. */
  releasePending(): void {
    if (this.#pending > 0) this.#pending -= 1
  }

  add(ws: ServerWebSocket<WebSocketContext>): void {
    // The reserved slot becomes the slot of the connection.
    if (this.#pending > 0) this.#pending -= 1
    this.#connections.add(ws)
  }

  remove(ws: ServerWebSocket<WebSocketContext>): void {
    this.#connections.delete(ws)
  }

  get connections(): ReadonlySet<ServerWebSocket<WebSocketContext>> {
    return this.#connections
  }
}

/**
 * The headers of the client handshake that belong to the handshake itself.
 *
 * They are never forwarded: the gateway performs a handshake of its own with
 * the upstream, and the keys, the version and the compression of the client
 * handshake do not apply to it.
 */
export const HANDSHAKE_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'sec-websocket-protocol',
]

/**
 * Reads the subprotocols the client offered.
 *
 * The offer is forwarded to the upstream, and the subprotocol the upstream
 * selects is mirrored back to the client. A gateway that keeps the two
 * handshakes apart lets a client and an application disagree about the
 * protocol they speak.
 */
export function offeredProtocols(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * Opens the connection to the upstream.
 *
 * The connection is opened before the client handshake is answered, so the
 * gateway knows the outcome of the upstream handshake and the negotiated
 * subprotocol before it sends the 101 to the client.
 *
 * The compression is disabled on this leg on purpose: the gateway
 * terminates the compression of the client leg, and a leg that negotiates
 * its compression on its own would send frames the other side cannot read.
 */
export async function connectUpstream(options: {
  url: string
  headers: Record<string, string>
  protocols: string[]
  handshakeTimeoutMs: number
}): Promise<UpstreamWebSocket> {
  const socket = new UpstreamWebSocket(
    options.url,
    options.protocols,
    {
      headers: options.headers,
      handshakeTimeout: options.handshakeTimeoutMs,
      // The compression of the two legs is negotiated separately, so the
      // upstream leg does not use it at all.
      perMessageDeflate: false,
    }
  )

  return await new Promise<UpstreamWebSocket>((resolve, reject) => {
    // The socket keeps an error listener for its whole life: a connection
    // that failed must not raise an unhandled error event later on.
    const ignore = (): void => {}
    socket.on('error', ignore)

    const settle = (error?: Error): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
      if (error) {
        try {
          socket.terminate()
        } catch {
          /* the socket is already gone */
        }
        reject(error)
        return
      }
      resolve(socket)
    }
    const onOpen = (): void => settle()
    const onError = (error: Error): void => settle(error)
    const timer = setTimeout(
      () => settle(new Error(`the upstream did not complete the handshake within ${options.handshakeTimeoutMs}ms`)),
      options.handshakeTimeoutMs + 500
    )
    timer.unref?.()
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

export function createWebSocketHandlers(options: WebSocketHandlerOptions) {
  const { logger, onEvent, registry } = options
  const pingIntervalMs = options.pingIntervalMs ?? 0
  const pongTimeoutMs = options.pongTimeoutMs ?? Math.max(pingIntervalMs * 3, 30_000)

  const emit = (event: WebSocketEvent): void => {
    onEvent?.(event)
  }

  const closeUpstream = (context: WebSocketContext, code = CLOSE_NORMAL, reason = ''): void => {
    const upstream = context.upstream
    context.upstream = undefined
    if (!upstream) return
    try {
      if (upstream.readyState === UpstreamWebSocket.OPEN) {
        upstream.close(code, truncateCloseReason(reason))
      } else {
        upstream.terminate()
      }
    } catch {
      try {
        upstream.terminate()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Closes a connection of the registry.
   *
   * The client and the upstream are closed together: a socket that is closed
   * on one side only leaves the other side waiting.
   */
  const closeConnection = (
    ws: ServerWebSocket<WebSocketContext>,
    code: number,
    reason: string
  ): void => {
    const context = ws.data
    if (context) {
      context.closed = true
      closeUpstream(context, code, reason)
    }
    try {
      ws.close(code, truncateCloseReason(reason))
    } catch {
      /* the connection is already gone */
    }
  }

  const flushBuffer = (context: WebSocketContext): void => {
    const upstream = context.upstream
    if (!upstream || upstream.readyState !== UpstreamWebSocket.OPEN) return
    for (const message of context.buffer) {
      try {
        upstream.send(message)
      } catch (error) {
        logger.warn('websocket send failed', { routeId: context.routeId, error })
        break
      }
    }
    context.buffer = []
    context.bufferedBytes = 0
  }

  /**
   * Attaches the relay to an upstream connection.
   *
   * The connection was opened by the gateway before the client handshake was
   * answered, so it is already open when the relay starts.
   */
  const relay = (ws: ServerWebSocket<WebSocketContext>, upstream: UpstreamWebSocket): void => {
    const context = ws.data
    if (!context) return
    context.upstream = upstream

    upstream.on('pong', () => {
      context.lastUpstreamPongAt = Date.now()
    })

    upstream.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (context.closed) return
      try {
        const payload = isBinary ? new Uint8Array(data as Buffer) : data.toString()
        const size = typeof payload === 'string' ? payload.length : payload.byteLength
        const status = ws.send(payload)
        // Bun reports the state of the send: -1 means the message was
        // queued because the client is slower than the upstream, 0 means it
        // was dropped. A client that does not read grows the queue of the
        // process without limit, so the connection is closed instead.
        if (status === 0 && size > 0) {
          logger.warn('websocket message dropped, closing connection', {
            routeId: context.routeId,
            requestId: context.requestId,
          })
          closeConnection(ws, CLOSE_TRY_AGAIN_LATER, 'the client is too slow')
          return
        }
        if (status < 0) {
          context.backpressure += 1
          if (context.backpressure >= MAX_CONSECUTIVE_BACKPRESSURE) {
            logger.warn('websocket client is too slow, closing connection', {
              routeId: context.routeId,
              requestId: context.requestId,
              backpressure: context.backpressure,
            })
            closeConnection(ws, CLOSE_TRY_AGAIN_LATER, 'the client is too slow')
          }
        } else {
          context.backpressure = 0
        }
      } catch (error) {
        logger.warn('websocket relay to client failed', { routeId: context.routeId, error })
      }
    })

    upstream.on('error', (error: Error) => {
      logger.warn('websocket upstream error', {
        routeId: context.routeId,
        requestId: context.requestId,
        error,
      })
      emit({
        type: 'error',
        routeId: context.routeId,
        requestId: context.requestId,
        error: error.message,
      })
      try {
        ws.close(CLOSE_GOING_AWAY, 'upstream error')
      } catch {
        /* ignore */
      }
    })

    upstream.on('close', (code: number, reason: Buffer) => {
      closeUpstream(context)
      try {
        ws.close(
          code >= 1000 && code <= 4999 ? code : CLOSE_NORMAL,
          truncateCloseReason(reason?.toString() ?? '')
        )
      } catch {
        /* ignore */
      }
    })
  }

  /**
   * The keepalive of the open connections.
   *
   * The gateway pings the client and the upstream. The ping keeps the
   * connection alive through the proxies in between, and it tells the
   * gateway that the other side is still there: a connection that does not
   * answer the pings is closed, so the registry does not count the
   * connections of the clients that went away without a close frame.
   */
  const keepalive = (): void => {
    const now = Date.now()
    // The set is copied: a connection that is closed in the loop is removed
    // from the registry.
    for (const ws of [...registry.connections]) {
      const context = ws.data
      if (!context || context.closed) continue
      // A young connection did not have the time to answer a ping yet, so
      // it is never closed for that. It is pinged all the same, otherwise
      // the other side would never answer either.
      const young = now - context.openedAt < pongTimeoutMs
      try {
        ws.ping()
      } catch {
        /* the connection is already gone */
      }
      if (!young && now - context.lastPongAt > pongTimeoutMs) {
        logger.warn('websocket client did not answer, closing connection', {
          routeId: context.routeId,
          requestId: context.requestId,
        })
        closeConnection(ws, CLOSE_GOING_AWAY, 'the client did not answer')
        continue
      }
      const upstream = context.upstream
      if (!upstream) continue
      try {
        upstream.ping()
      } catch {
        /* the connection is already gone */
      }
      if (!young && now - context.lastUpstreamPongAt > pongTimeoutMs) {
        logger.warn('websocket upstream did not answer, closing connection', {
          routeId: context.routeId,
          requestId: context.requestId,
        })
        closeConnection(ws, CLOSE_GOING_AWAY, 'the upstream did not answer')
      }
    }
  }

  let keepaliveTimer: ReturnType<typeof setInterval> | undefined
  if (pingIntervalMs > 0) {
    keepaliveTimer = setInterval(keepalive, pingIntervalMs)
    keepaliveTimer.unref?.()
  }

  return {
    open(ws: ServerWebSocket<WebSocketContext>): void {
      const context = ws.data
      if (!context) {
        ws.close(CLOSE_GOING_AWAY, 'missing context')
        return
      }
      registry.add(ws)

      const upstream = context.upstream
      if (!upstream) {
        // The gateway opens the upstream connection before it answers the
        // client, so this is the exceptional case.
        ws.close(CLOSE_GOING_AWAY, 'the upstream connection is missing')
        return
      }

      relay(ws, upstream)
      flushBuffer(context)
      emit({ type: 'open', routeId: context.routeId, requestId: context.requestId })
    },

    message(ws: ServerWebSocket<WebSocketContext>, message: string | Uint8Array): void {
      const context = ws.data
      if (!context || context.closed) return
      const upstream = context.upstream
      const size = typeof message === 'string' ? message.length : message.byteLength

      if (!upstream || upstream.readyState === UpstreamWebSocket.CONNECTING) {
        // Buffer while the upstream handshake is still in flight, with a hard cap.
        if (
          context.buffer.length >= context.maxBufferedMessages ||
          context.bufferedBytes + size > context.maxBufferedBytes
        ) {
          logger.warn('websocket buffer limit exceeded, closing connection', {
            routeId: context.routeId,
            requestId: context.requestId,
          })
          try {
            ws.close(CLOSE_TRY_AGAIN_LATER, 'buffer limit exceeded')
          } catch {
            /* ignore */
          }
          context.closed = true
          closeUpstream(context)
          return
        }
        context.buffer.push(message)
        context.bufferedBytes += size
        return
      }

      if (upstream.readyState !== UpstreamWebSocket.OPEN) {
        try {
          ws.close(CLOSE_GOING_AWAY, 'upstream unavailable')
        } catch {
          /* ignore */
        }
        return
      }

      // The upstream is slower than the client: the messages of the client
      // are queued in the gateway. The queue is bounded, a connection that
      // exceeds it is closed instead of growing the memory of the process.
      if (upstream.bufferedAmount > context.maxBufferedBytes) {
        logger.warn('websocket upstream is too slow, closing connection', {
          routeId: context.routeId,
          requestId: context.requestId,
          buffered: upstream.bufferedAmount,
        })
        try {
          ws.close(CLOSE_TRY_AGAIN_LATER, 'the upstream is too slow')
        } catch {
          /* ignore */
        }
        context.closed = true
        closeUpstream(context)
        return
      }

      try {
        upstream.send(message)
      } catch (error) {
        logger.warn('websocket relay to upstream failed', { routeId: context.routeId, error })
      }
    },

    /**
     * Called when the client answers a ping of the gateway.
     *
     * The answer is the proof that the client is still there.
     */
    pong(ws: ServerWebSocket<WebSocketContext>): void {
      const context = ws.data
      if (!context) return
      context.lastPongAt = Date.now()
    },

    /**
     * Called when the client caught up with the messages of the gateway.
     *
     * The counter of the slow sends starts again.
     */
    drain(ws: ServerWebSocket<WebSocketContext>): void {
      const context = ws.data
      if (!context) return
      context.backpressure = 0
    },

    close(ws: ServerWebSocket<WebSocketContext>, code: number, reason: string): void {
      const context = ws.data
      registry.remove(ws)
      if (!context) return
      context.closed = true
      closeUpstream(context)
      emit({
        type: 'close',
        routeId: context.routeId,
        requestId: context.requestId,
        code,
        error: reason || undefined,
      })
    },

    /**
     * Closes every open connection.
     *
     * The server calls this before it stops the listener: a websocket that
     * stays open would keep the shutdown waiting for it.
     */
    closeAll(code: number = CLOSE_GOING_AWAY, reason: string = 'the gateway is shutting down'): number {
      const open = [...registry.connections]
      for (const ws of open) {
        closeConnection(ws, code, reason)
        registry.remove(ws)
      }
      return open.length
    },

    /** The number of connections that are currently open. */
    get connectionCount(): number {
      return registry.connectionCount
    },

    /**
     * Stops the keepalive.
     *
     * The server calls it when it stops the listener: a timer that keeps
     * running would keep the process alive.
     */
    stop(): void {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = undefined
      }
    },
  }
}
