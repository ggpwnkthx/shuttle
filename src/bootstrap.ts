/**
 * Startup of the gateway.
 *
 * The container entry point (`src/index.ts`) and the development runner
 * (`scripts/dev.ts`) both use this module, so the gateway behaves the same in
 * both cases.
 */

import { readEnv, type Env } from './runtime/env'
import { createRuntime, type Runtime } from './runtime/runtime'
import { startServers, type StartedServers } from './server'

export interface BootstrappedGateway {
  runtime: Runtime
  servers: StartedServers
  /** Stops the listener and lets the in-flight requests finish. */
  shutdown: (signal: string) => Promise<void>
}

/**
 * Reads the environment, loads the configuration and starts the listener.
 *
 * A configuration that cannot be loaded is fatal, unless a previous
 * configuration is still active: the gateway then keeps serving the routes
 * it knows and reports the problem in the logs and in the metrics.
 */
export async function bootstrapGateway(env: Env = process.env): Promise<BootstrappedGateway> {
  const options = readEnv(env)
  const runtime = createRuntime(options)

  const result = await runtime.config.reload()
  if (!result.ok) {
    runtime.logger.error('the initial configuration is invalid', { error: result.error })
    if (!runtime.config.loaded) {
      runtime.logger.error('the gateway cannot start without a valid configuration')
      process.exit(1)
    }
  } else {
    runtime.logger.info('configuration loaded', {
      revision: result.revision,
      routes: result.routes,
      source: runtime.config.source,
    })
  }

  runtime.config.watchForChanges()
  runtime.config.onReload((reload) => {
    if (reload.ok) {
      runtime.logger.info('configuration reloaded', { revision: reload.revision, routes: reload.routes })
      runtime.metrics.recordConfigReload(true)
    } else {
      runtime.logger.error('configuration reload failed, keeping the previous configuration', {
        error: reload.error,
      })
      runtime.metrics.recordConfigReload(false)
    }
  })

  const servers = await startServers(runtime)

  // The session store is shared by every replica: report right away when it
  // cannot be reached, the readiness probe takes the task out of the
  // rotation in that case.
  const sessionStoreReady = await runtime.sessions.ping()
  runtime.logger.info('session store status', {
    url: new URL(runtime.options.session.url).protocol,
    reachable: sessionStoreReady,
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    runtime.logger.info('received a termination signal', { signal })
    await servers.stop()
  }

  return { runtime, servers, shutdown }
}
