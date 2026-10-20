/**
 * The listener of the gateway.
 *
 * The platform owns the socket: it starts the listener, it knows the
 * address of the peer of a request and it stops accepting when the runtime
 * drains.
 */

import type { WebSocketHandler } from 'bun'
import { BunClientUpgrade } from './client-upgrade'

/**
 * The application, as the listener sees it.
 *
 * The platform does not know the application and it does not know the
 * framework of the application: it knows that something answers a request.
 * The environment of the request is opaque here, the application builds it.
 */
export interface RequestHandler {
  handle(request: Request, env: never): Response | Promise<Response>
}

export interface ListenerOptions {
  /** The application that answers the requests. */
  app: RequestHandler
  /** The address the listener binds to. */
  host: string
  /** The port the listener binds to. */
  port: number
  /** The websockets of the runtime, when the deployment has them. */
  websocket?: {
    /** The handlers of the connections. */
    handlers: WebSocketHandler<unknown>
    /** The maximum size of a message of a connection. */
    maxPayloadLength: number
    /** The number of bytes that may be queued for a caller that does not read. */
    backpressureLimitBytes: number
    /** How long a connection may stay silent, in seconds. */
    idleTimeoutSeconds: number
  }
  /** Called when the runtime of the server reports an error. */
  onError?: (error: unknown) => void
}

export interface StartedListener {
  /** The port the listener listens on. */
  port: number
  /** The url of the listener. */
  url: string
  /**
   * The address of the peer of a request.
   *
   * It is the address of the socket: the gateway needs it to know whether
   * the forwarding headers of a request may be trusted.
   */
  peerAddress: (request: Request) => string
  /** Stops the listener; `force` closes the connections that are open. */
  stop: (force: boolean) => Promise<void>
}

/**
 * Starts the listener of the gateway.
 *
 * The peer address of a request is the address of the socket: the gateway
 * needs it to know whether the forwarding headers of a request may be
 * trusted.
 */
export function startListener(options: ListenerOptions): StartedListener {
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    // The idle timeout of the connections of the runtime. The long lived
    // streams (the events of an upstream) keep the connection busy.
    idleTimeout: 120,
    fetch(request, bunServer) {
      // The upgrade of a websocket connection is a capability of the
      // runtime: the application hands it to the domain of the websockets.
      const env = { upgrade: new BunClientUpgrade(bunServer as unknown as Bun.Server<unknown>) }
      return options.app.handle(request, env as never)
    },
    ...(options.websocket
      ? {
          websocket: {
            ...options.websocket.handlers,
            // The size of a message and the queue of a caller that does not
            // read are bounded: the memory of the process stays bounded,
            // whatever the client and the upstream do.
            maxPayloadLength: options.websocket.maxPayloadLength,
            backpressureLimit: options.websocket.backpressureLimitBytes,
            closeOnBackpressureLimit: true,
            idleTimeout: options.websocket.idleTimeoutSeconds,
          },
        }
      : {}),
    error(error) {
      options.onError?.(error)
    },
  } as Parameters<typeof Bun.serve>[0])

  return {
    port: server.port ?? 0,
    url: `http://${options.host}:${server.port}`,
    peerAddress: (request: Request) => {
      const address = server.requestIP(request)
      return address?.address ?? '0.0.0.0'
    },
    stop: async (force: boolean) => {
      await server.stop(force)
    },
  }
}
