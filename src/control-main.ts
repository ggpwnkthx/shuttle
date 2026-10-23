#!/usr/bin/env bun
/**
 * The entry point of the control plane.
 *
 * The control plane is a separate process: it reads its own environment,
 * it opens the shared state it acts on and it starts its own listener. It
 * is never routed through the gateway, and the gateway knows nothing of
 * it.
 */
import { readControlEnv } from './runtime/env'
import { createControlRuntime } from './runtime/control'
import { assertRuntimeVersion } from './runtime/version'

async function main(): Promise<void> {
  assertRuntimeVersion()

  const settings = readControlEnv(process.env)
  const runtime = await createControlRuntime(settings)

  runtime.logger.info('the listener of the control plane started', {
    control: `http://${settings.host}:${runtime.listener.port}`,
    state: settings.stateUrl.replace(/\/\/[^@]*@/, '//***@'),
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    void runtime.drain(signal).then(async () => {
      await runtime.close()
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'the control plane failed to start',
      error: String(error),
    })
  )
  process.exit(1)
})
