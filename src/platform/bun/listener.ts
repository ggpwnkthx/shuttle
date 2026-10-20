/**
 * The listener of the gateway.
 *
 * The platform owns the socket: it starts the listener, it knows the
 * address of the peer of a request and it stops accepting when the runtime
 * drains.
 */

import type { ExecutionContext } from 'hono'
import type { WebSocketHandler } from 'bun'

/**
 * The application, as the listener sees it.
 *
 * The platform does not know the application: it knows that something
 * answers a request.
 */
export interface RequestHandler {
  fetch(request: Request, env: unknown, context: ExecutionContext): Response | Promise<Response>
}

export interface ListenerOptions {
  /** The application that answers the requests. */
  app: RequestHandler
  /** The address the listener binds to. */
  host: string
  /** The port the listener binds to. */
  port: number
  /** The websocket handler of the runtime, when the deployment has one. */
  websocket?: WebSocketHandler<unknown>
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
  const executionCtx: ExecutionContext = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  }

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    // The idle timeout of the connections of the runtime. The long lived
    // streams (the events of an upstream) keep the connection busy.
    idleTimeout: 120,
    fetch(request, bunServer) {
      return options.app.fetch(request, bunServer as unknown as Record<string, never>, executionCtx)
    },
    ...(options.websocket ? { websocket: options.websocket } : {}),
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
