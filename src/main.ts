#!/usr/bin/env bun
/**
 * The entry point of the gateway.
 *
 * The runtime reads the environment, loads the configuration, starts the
 * listener and waits for a termination signal. Everything else lives in
 * the runtime and in the domains.
 */
import { readEnv } from './runtime/env'
import { createRuntime } from './runtime/composition'
import { loadInitialConfiguration, watchConfiguration, watchRouteTable } from './runtime/lifecycle'
import { assertRuntimeVersion } from './runtime/version'

async function main(): Promise<void> {
  // The runtime is the contract of the release: a gateway that starts on a
  // runtime that does not have the boundaries it relies on answers in ways
  // its specification does not describe, and the difference is only
  // visible in production.
  assertRuntimeVersion()

  const settings = readEnv(process.env)
  const runtime = await createRuntime(settings)

  // The configuration is loaded before the listener accepts: a gateway
  // without a configuration has no routes to offer.
  //
  // The source of the table is either the file or the shared state
  // (§3.4 of the specification). In the store mode the table of the
  // active revision is loaded, and the file is the fallback of a store
  // that is empty or that cannot be reached.
  const source = settings.configSource
  let watcher: { stop: () => void; ready?: Promise<void> } | null = null

  if (source === 'store') {
    const routeTable = runtime.routeTable
    if (!routeTable) {
      runtime.logger.error('the route table of the shared state is not configured')
      runtime.logger.error('the gateway cannot start without a route table')
      await runtime.close()
      process.exit(1)
    }
    // The table of the active revision is loaded, and the file is the
    // fallback of a store that is empty or that cannot be reached.
    const loaded = await loadInitialConfiguration({
      store: runtime.config,
      path: settings.configPath,
      routeTable,
      logger: runtime.logger,
      observer: runtime.observer,
    })
    if (!loaded) {
      runtime.logger.error('the gateway cannot start without a valid route table')
      await runtime.close()
      process.exit(1)
    }
    const routeTableWatcher = watchRouteTable({
      store: runtime.config,
      routeTable,
      logger: runtime.logger,
      observer: runtime.observer,
      replicaId: runtime.replicaId,
    })
    watcher = routeTableWatcher
  } else {
    const loaded = await loadInitialConfiguration({
      store: runtime.config,
      path: settings.configPath,
      logger: runtime.logger,
      observer: runtime.observer,
    })
    if (!loaded) {
      runtime.logger.error('the gateway cannot start without a valid configuration')
      await runtime.close()
      process.exit(1)
    }
    watcher = watchConfiguration({
      store: runtime.config,
      logger: runtime.logger,
      observer: runtime.observer,
      path: settings.configPath,
    })
    await watcher.ready
  }

  // The session store is shared by every replica: report right away when it
  // cannot be reached, the readiness probe takes the task out of the
  // rotation in that case.
  const sessionStoreReady = await runtime.auth.sessions.ping()
  runtime.logger.info('the session store status', {
    protocol: new URL(settings.session.url).protocol,
    reachable: sessionStoreReady,
  })

  runtime.logger.info('the listener started', {
    gateway: `http://${settings.network.host}:${runtime.listener.port}`,
    configSource: source,
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    void runtime.drain(signal).then(async () => {
      watcher?.stop()
      await runtime.close()
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the gateway failed to start', error: String(error) })
  )
  process.exit(1)
})
