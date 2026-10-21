#!/usr/bin/env bun
/**
 * The entry point of the gateway.
 *
 * The runtime reads the environment, loads the configuration, starts the
 * listener and waits for a termination signal. Everything else lives in the
 * runtime and in the domains.
 */
import { readEnv } from './runtime/env'
import { createRuntime } from './runtime/composition'
import { watchConfiguration } from './runtime/lifecycle'
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
  const loaded = runtime.config.apply(JSON.parse(await readConfig(settings.configPath)))
  if (!loaded.ok) {
    runtime.logger.error('the initial configuration is invalid', { error: loaded.error })
    if (!runtime.config.loaded) {
      runtime.logger.error('the gateway cannot start without a valid configuration')
      await runtime.close()
      process.exit(1)
    }
  } else {
    runtime.logger.info('the configuration was loaded', {
      revision: loaded.revision,
      routes: loaded.routes,
      source: runtime.config.source,
    })
    // The policy that is running is written in the log by the store, when
    // it publishes the generation.
    runtime.observer.recordConfigReload(true)
  }

  const watcher = watchConfiguration({
    store: runtime.config,
    logger: runtime.logger,
    observer: runtime.observer,
    path: settings.configPath,
  })
  await watcher.ready

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
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    void runtime.drain(signal).then(async () => {
      watcher.stop()
      await runtime.close()
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

/** Reads the configuration file of the deployment. */
async function readConfig(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path, 'utf8')
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the gateway failed to start', error: String(error) })
  )
  process.exit(1)
})
