/**
 * The ports of the websocket domain.
 *
 * The domain owns the reservation of a slot, the order of the handshake (the
 * upstream first, the caller second) and the bridge between the two legs. The
 * runtime owns the sockets: the domain never touches a socket of the
 * runtime, it receives the two legs through these ports.
 */

/** A message of a websocket connection. */
export type WebSocketMessage = string | Uint8Array

/** The events of the upstream leg of a websocket pair. */
export interface UpstreamSocketEvents {
  message: (message: WebSocketMessage, isBinary: boolean) => void
  close: (code: number, reason: string) => void
  error: (error: Error) => void
  pong: () => void
}

/**
 * The upstream leg of a websocket pair.
 *
 * The interface is deliberately small: it is the part of a socket the
 * domain needs, not the api of the library that happens to implement it.
 */
export interface UpstreamSocket {
  /** Queues a message for the upstream. */
  send(message: WebSocketMessage): void
  /** Closes the connection with a code and a reason. */
  close(code?: number, reason?: string): void
  /** Drops the connection without a close frame. */
  terminate(): void
  /** The number of bytes that are queued for the upstream. */
  readonly bufferedAmount: number
  /** Registers a listener for the events of the connection. */
  on<E extends keyof UpstreamSocketEvents>(event: E, listener: UpstreamSocketEvents[E]): void
  /** Sends a ping frame. */
  ping(): void
}

/** The request of the handshake with the upstream. */
export interface UpstreamHandshakeRequest {
  /** The absolute url of the upstream, `ws://` or `wss://`. */
  url: string
  /** The headers of the handshake, already filtered by the forwarding domain. */
  headers: Record<string, string>
  /** The subprotocols the caller offered. */
  protocols: string[]
  /** How long the handshake may take. */
  timeoutMs: number
}

/**
 * The outcome of the handshake with the upstream.
 *
 * The three outcomes are kept apart on purpose: a refusal of the upstream
 * is not a failure of the network, and the caller deserves to see the status
 * of the refusal.
 */
export type UpstreamHandshakeOutcome =
  | { kind: 'accepted'; protocol: string; headers: Headers; socket: UpstreamSocket }
  | { kind: 'refused'; status: number; headers: Headers; body: string }
  | { kind: 'failed'; reason: 'timeout' | 'network'; message: string }

/**
 * The port of the handshake with the upstream.
 *
 * The implementation opens the connection before the caller is answered, so
 * the gateway knows the outcome of the handshake and the subprotocol the
 * upstream selected.
 */
export interface UpstreamHandshakePort {
  connect(request: UpstreamHandshakeRequest): Promise<UpstreamHandshakeOutcome>
}

/** The caller leg of a websocket pair. */
export interface ClientLeg {
  /**
   * Queues a message for the caller.
   *
   * The runtime reports the state of the queue: a negative value means the
   * caller is slower than the upstream, a zero means the message was
   * dropped.
   */
  send(message: WebSocketMessage): number
  /** Closes the connection with a code and a reason. */
  close(code?: number, reason?: string): void
  /** Drops the connection without a close frame. */
  terminate(): void
  /** The number of bytes that are queued for the caller. */
  readonly bufferedAmount: number
  /** Sends a ping frame. */
  ping(): void
}

/**
 * The port of the upgrade of the caller.
 *
 * The upgrade is the answer of the gateway to the handshake of the caller:
 * it carries the request id and the refreshed cookie of the session, so the
 * caller learns about them.
 */
export interface ClientUpgradePort {
  /**
   * Upgrades the connection of the caller.
   *
   * It returns null when the request is not a websocket handshake or when
   * the runtime refused the upgrade.
   */
  upgrade(
    request: Request,
    options: { headers?: Record<string, string> }
  ): Promise<ClientLeg | null>
}
