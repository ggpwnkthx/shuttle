import { createGatewayApp } from './gateway/app'
import { createWebSocketHandlers, WebSocketRegistry } from './gateway/websocket'
import type { ExecutionContext } from 'hono'
import type { Runtime } from './runtime/runtime'

export interface StartedServers {
  gateway: Bun.Server<unknown>
  stop: () => Promise<void>
}

/** Starts the public gateway listener. */
export async function startServers(runtime: Runtime): Promise<StartedServers> {
  const logger = runtime.logger
  // The registry is shared: the gateway needs it to know how many
  // connections are open before it accepts another one.
  const registry = new WebSocketRegistry(runtime.options.websocketMaxConnections)
  const gatewayApp = createGatewayApp(runtime, { websockets: registry })

  const websocket = createWebSocketHandlers({
    logger,
    registry,
    pingIntervalMs: runtime.options.websocketPingIntervalMs,
    pongTimeoutMs: runtime.options.websocketPongTimeoutMs,
    onEvent: (event) => {
      if (event.type === 'open') {
        logger.info('websocket opened', { routeId: event.routeId, requestId: event.requestId })
      }
      if (event.type === 'close' || event.type === 'error') {
        logger.warn('websocket closed', {
          routeId: event.routeId,
          requestId: event.requestId,
          type: event.type,
          error: event.error,
        })
      }
    },
  })

  const executionCtx: ExecutionContext = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }

  const gateway = Bun.serve({
    port: runtime.options.gatewayPort,
    hostname: runtime.options.gatewayHost,
    idleTimeout: 120,
    fetch(request, server) {
      return gatewayApp.fetch(request, server as unknown as Bun.Server<unknown>, executionCtx)
    },
    websocket: {
      ...(websocket as unknown as Bun.WebSocketHandler<unknown>),
      // The size of a message and the queue of a client that does not read
      // are bounded: the memory of the process stays bounded, whatever the
      // client and the upstream do.
      maxPayloadLength: runtime.options.websocketMaxPayloadBytes,
      backpressureLimit: runtime.options.websocketBackpressureLimitBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: runtime.options.websocketIdleTimeoutSeconds,
    },
    error(error) {
      logger.error('gateway server error', { error })
    },
  })

  logger.info('listener started', {
    gateway: `http://${runtime.options.gatewayHost}:${gateway.port}`,
  })

  let stopping: Promise<void> | null = null
  const stop = async (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      logger.info('shutting down')
      runtime.config.close()

      // The keepalive stops with the listener: a timer that keeps running
      // would keep the process alive.
      websocket.stop()

      // A websocket never finishes on its own, so `stop(false)` — which
      // waits for the open connections — would wait for it forever. The
      // websockets are closed first, then the requests that are still in
      // flight get a bounded amount of time to finish.
      const closed = websocket.closeAll()
      if (closed > 0) {
        logger.info('the open websockets were closed', { connections: closed })
      }

      const deadlineMs = runtime.options.shutdownTimeoutMs
      const drained = await Promise.race([
        gateway.stop(false).then(
          () => true,
          () => false
        ),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), deadlineMs)
          timer.unref?.()
        }),
      ])
      if (!drained) {
        logger.warn('the shutdown deadline was reached, the remaining connections are closed', {
          deadlineMs,
        })
      }
      await gateway.stop(true)

      // The session store owns a connection to the shared cache, it is
      // closed with the gateway.
      await runtime.sessions.close()
      // The connections to the shared state are closed as well.
      await runtime.close()
      logger.info('shutdown complete')
    })()
    return stopping
  }

  return { gateway, stop }
}
