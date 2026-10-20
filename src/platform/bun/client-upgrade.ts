/**
 * The upgrade of the caller.
 *
 * The platform owns the socket: it upgrades the connection of the caller
 * and it reports the events of the connection. The domain decides what the
 * handshake means and it owns the bridge between the two legs.
 */

import type { ServerWebSocket } from 'bun'
import type {
  ClientEventHandlers,
  ClientLeg,
  ClientUpgradePort,
  ClientUpgradeResult,
  WebSocketMessage,
} from '../../domains/websockets'

/**
 * The leg of the caller.
 *
 * The socket of the runtime only exists once the connection is open, so
 * the leg is a promise of a socket: the messages that arrive before the
 * connection is open are dropped, exactly like the runtime does.
 */
export class BunClientLeg implements ClientLeg {
  #socket: ServerWebSocket<unknown> | undefined

  /** Attaches the socket of the runtime to the leg. */
  attach(socket: ServerWebSocket<unknown>): void {
    this.#socket = socket
  }

  send(message: WebSocketMessage): number {
    if (!this.#socket) return 0
    return this.#socket.send(message as string | Uint8Array)
  }

  close(code?: number, reason?: string): void {
    try {
      this.#socket?.close(code, reason)
    } catch {
      /* the connection is already gone */
    }
  }

  terminate(): void {
    try {
      this.#socket?.terminate()
    } catch {
      /* the connection is already gone */
    }
  }

  get bufferedAmount(): number {
    return this.#socket?.getBufferedAmount() ?? 0
  }

  ping(): void {
    try {
      this.#socket?.ping()
    } catch {
      /* the connection is already gone */
    }
  }
}

/** The data of a websocket connection of the runtime. */
export interface BunWebSocketData {
  /** The leg of the caller. */
  leg: BunClientLeg
  /** The handlers of the events of the connection. */
  events: ClientEventHandlers
}

export class BunClientUpgrade implements ClientUpgradePort {
  #server: Bun.Server<unknown>

  constructor(server: Bun.Server<unknown>) {
    this.#server = server
  }

  async upgrade(
    request: Request,
    options: { headers?: Record<string, string> }
  ): Promise<ClientUpgradeResult | null> {
    const leg = new BunClientLeg()
    const events: ClientEventHandlers = {}
    const upgraded = this.#server.upgrade(request, {
      data: { leg, events } satisfies BunWebSocketData,
      headers: options.headers,
    })
    if (!upgraded) return null
    return { leg, events }
  }
}

/**
 * The handlers of the websocket connections of the runtime.
 *
 * The runtime reports the events of a connection, the domain decides what
 * they mean.
 */
export function createWebSocketHandlers() {
  return {
    open(ws: ServerWebSocket<BunWebSocketData>) {
      ws.data.leg.attach(ws as ServerWebSocket<unknown>)
    },
    message(ws: ServerWebSocket<BunWebSocketData>, message: string | Uint8Array) {
      ws.data.events.message?.(message)
    },
    close(ws: ServerWebSocket<BunWebSocketData>, code: number, reason: string) {
      ws.data.events.close?.(code, reason)
    },
    pong(ws: ServerWebSocket<BunWebSocketData>) {
      ws.data.events.pong?.()
    },
    drain(ws: ServerWebSocket<BunWebSocketData>) {
      ws.data.events.drain?.()
    },
  }
}
