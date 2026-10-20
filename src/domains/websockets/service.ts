/**
 * The handshake of a websocket connection.
 *
 * The gateway opens the connection to the upstream **before** it answers the
 * caller, so the caller learns the outcome of the handshake and the
 * subprotocol the upstream selected. The handshake headers of the caller
 * are not forwarded: the gateway performs a handshake of its own.
 *
 * The order of the steps is the one of the specification:
 *
 * 1. the origin of the handshake is checked (a handshake that carries the
 *    cookie of the session has to name an allowed origin);
 * 2. a slot is reserved (the handshakes that are in flight count);
 * 3. the upstream is connected within the handshake deadline;
 * 4. the caller is upgraded with the headers of the gateway;
 * 5. the two legs are bridged.
 *
 * A failure at any step releases the slot and closes the leg that was
 * opened.
 */

import { buildWebsocketTarget, checkWebsocketOrigin } from '../forwarding'
import { WebSocketBridge } from './bridge'
import type { ReservationManager } from './reservation'
import type { WebSocketUpgradeContext } from './context'
import type {
  ClientUpgradePort,
  UpstreamHandshakePort,
  UpstreamHandshakeRequest,
  UpstreamSocket,
} from './ports'
import type { Logger, Observer } from '../../observability'

/** The settings of the websockets of a deployment. */
export interface WebSocketSettings {
  /** The number of connections that may be open at the same time. */
  maxConnections: number
  /** The number of bytes that may wait for the other leg. */
  maxBufferedBytes: number
  /** The number of messages that may wait for the other leg. */
  maxBufferedMessages: number
  /** The number of bytes that may be queued for a caller that does not read. */
  backpressureLimitBytes: number
  /** How often the gateway pings the legs, in milliseconds. */
  pingIntervalMs: number
  /** How long a leg may stay silent, in milliseconds. */
  pongTimeoutMs: number
  /** How long the handshake of the upstream may take, in milliseconds. */
  handshakeTimeoutMs: number
}

/** The options of the service of the websockets. */
export interface WebSocketServiceOptions {
  /** The handshake with the upstream. */
  upstream: UpstreamHandshakePort
  /** The reservations of the connections. */
  reservations: ReservationManager
  /** The settings of the deployment. */
  settings: WebSocketSettings
  /** The logger of the gateway. */
  logger: Logger
  /** The observer of the gateway. */
  observer: Observer
}

/**
 * The outcome of an upgrade.
 *
 * The domain decides what happened, the application renders the answer of
 * the protocol: a typed outcome is mapped to a response at the boundary.
 */
export type WebSocketOutcome =
  | { kind: 'upgraded' }
  | { kind: 'refused'; status: number; code: string; message: string }

/** The port the application uses to upgrade a caller. */
export interface WebSocketServicePort {
  /**
   * Handles an upgrade request.
   *
   * The domain owns the handshake and the bridge; it reports the outcome and
   * the application answers the caller.
   */
  handle(
    request: Request,
    context: WebSocketUpgradeContext,
    upgrade: ClientUpgradePort
  ): Promise<WebSocketOutcome>
}

/** The headers of the client handshake that belong to the handshake itself. */
const HANDSHAKE_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'sec-websocket-protocol',
]

/** The subprotocols the caller offered. */
export function offeredProtocols(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export class WebSocketService implements WebSocketServicePort {
  #upstream: UpstreamHandshakePort
  #reservations: ReservationManager
  #settings: WebSocketSettings
  #logger: Logger
  #observer: Observer
  /** The bridges that are open, so a drain can close them. */
  #bridges = new Set<WebSocketBridge>()

  constructor(options: WebSocketServiceOptions) {
    this.#upstream = options.upstream
    this.#reservations = options.reservations
    this.#settings = options.settings
    this.#logger = options.logger
    this.#observer = options.observer
  }

  /** The number of connections that are open. */
  get connectionCount(): number {
    return this.#reservations.openCount
  }

  /** Closes every open connection and returns how many there were. */
  closeAll(): number {
    const bridges = [...this.#bridges]
    for (const bridge of bridges) {
      bridge.close(1001, 'the gateway is shutting down')
    }
    return bridges.length
  }

  async handle(
    request: Request,
    context: WebSocketUpgradeContext,
    upgrade: ClientUpgradePort
  ): Promise<WebSocketOutcome> {
    // 1. The origin of the handshake. A handshake that carries the cookie
    // of the session is a handshake of a browser, and a browser always
    // sends the origin of the page.
    if (context.carriesSessionCookie) {
      const origin = checkWebsocketOrigin({
        method: context.method,
        headers: context.headers,
        host: context.host,
        externalProto: context.externalProto,
        allowedOrigins: context.allowedOrigins,
      })
      if (!origin.allowed) {
        this.#logger.warn('a websocket handshake was refused', {
          requestId: context.requestId,
          routeId: context.routeId,
          reason: origin.reason,
        })
        this.#observer.recordWebsocketRefusal('cross_site')
        return {
          kind: 'refused',
          status: 403,
          code: 'cross_site_request',
          message: origin.reason ?? 'the handshake was refused',
        }
      }
    }

    // 2. The reservation. The handshakes that are in flight count, so a
    // caller cannot open more connections than the deployment allows.
    if (!this.#reservations.reserve()) {
      this.#logger.warn('the websocket connection limit was reached', {
        requestId: context.requestId,
        routeId: context.routeId,
      })
      this.#observer.recordWebsocketRefusal('connection_limit')
      return {
        kind: 'refused',
        status: 503,
        code: 'too_many_connections',
        message: 'the gateway has too many open connections',
      }
    }

    // 3. The upstream is connected first: the caller learns the outcome of
    // the handshake and the subprotocol the upstream selected.
    const url = buildWebsocketTarget(context.upstream, context.path, context.search)
    const headers = this.#headersOf(context)
    const request_: UpstreamHandshakeRequest = {
      url,
      headers,
      protocols: offeredProtocols(context.headers.get('sec-websocket-protocol') ?? undefined),
      timeoutMs: this.#settings.handshakeTimeoutMs,
    }

    const outcome = await this.#upstream.connect(request_)
    if (outcome.kind !== 'accepted') {
      this.#reservations.releasePending()
      this.#logger.warn('the upstream websocket handshake failed', {
        requestId: context.requestId,
        routeId: context.routeId,
        kind: outcome.kind,
        reason: outcome.kind === 'refused' ? outcome.status : outcome.reason,
      })
      this.#observer.recordWebsocketRefusal(
        outcome.kind === 'refused' ? 'upstream_refused' : 'upstream_unavailable'
      )
      return {
        kind: 'refused',
        status: 502,
        code: 'bad_gateway',
        message: 'the upstream did not accept the websocket connection',
      }
    }

    // 4. The caller is upgraded with the headers of the gateway: the
    // request id and the refreshed cookie of the session.
    const upgraded = await upgrade.upgrade(request, {
      headers: {
        'x-request-id': context.requestId,
        ...(context.cookies.length > 0 ? { 'set-cookie': context.cookies.join('\n') } : {}),
      },
    })
    if (!upgraded) {
      this.#reservations.releasePending()
      closeUpstream(outcome.socket)
      this.#logger.warn('the upgrade of the caller was refused', {
        requestId: context.requestId,
        routeId: context.routeId,
      })
      this.#observer.recordWebsocketRefusal('not_allowed')
      return {
        kind: 'refused',
        status: 400,
        code: 'websocket_upgrade_failed',
        message: 'the websocket upgrade was rejected',
      }
    }

    // 5. The two legs are bridged.
    const bridge = new WebSocketBridge({
      client: upgraded.leg,
      upstream: outcome.socket,
      maxBufferedBytes: this.#settings.maxBufferedBytes,
      maxBufferedMessages: this.#settings.maxBufferedMessages,
      backpressureLimitBytes: this.#settings.backpressureLimitBytes,
      pingIntervalMs: this.#settings.pingIntervalMs,
      pongTimeoutMs: this.#settings.pongTimeoutMs,
      onClose: () => {
        this.#bridges.delete(bridge)
        this.#reservations.release()
      },
      onError: (message) => {
        this.#logger.warn('the websocket connection reported a problem', {
          requestId: context.requestId,
          routeId: context.routeId,
          message,
        })
      },
    })
    this.#bridges.add(bridge)
    this.#reservations.promote()

    upgraded.events.message = (message) => bridge.relayToUpstream(message)
    upgraded.events.pong = () => bridge.notePong()
    upgraded.events.drain = () => bridge.noteDrain()
    upgraded.events.close = (code, reason) => bridge.close(code, reason)
    bridge.start()

    this.#observer.recordWebsocket(context.routeId)
    this.#logger.info('the websocket was upgraded', {
      requestId: context.requestId,
      routeId: context.routeId,
      protocol: outcome.protocol,
    })
    // The answer of the upgrade was already sent by the runtime.
    return { kind: 'upgraded' }
  }

  /** The headers of the handshake with the upstream. */
  #headersOf(context: WebSocketUpgradeContext): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of context.headers) {
      const lower = name.toLowerCase()
      // The handshake headers of the caller belong to the handshake of the
      // caller: the keys, the version and the compression of the client do
      // not apply to the handshake of the gateway.
      if (HANDSHAKE_HEADERS.includes(lower)) continue
      if (lower === 'host' || lower === 'connection' || lower === 'upgrade') continue
      headers[lower] = value
    }
    if (context.identity) {
      headers['x-shuttle-user'] = context.identity.subject
      if (context.identity.email) headers['x-shuttle-email'] = context.identity.email
      headers['x-shuttle-roles'] = context.identity.roles.join(',')
      if (context.identity.workspaceId) {
        headers['x-shuttle-workspace'] = context.identity.workspaceId
      }
    }
    if (context.signature) headers['x-shuttle-signature'] = context.signature
    return headers
  }
}

/** Closes the upstream leg of a connection that was not established. */
function closeUpstream(socket: UpstreamSocket): void {
  try {
    socket.terminate()
  } catch {
    /* the connection is already gone */
  }
}
