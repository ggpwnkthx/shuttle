#!/usr/bin/env bun
/**
 * The gateway, started the way the container starts it.
 *
 * The development runner (`scripts/dev.ts`) uses the same bootstrap, it only
 * adds the local services around it.
 */
import { bootstrapGateway } from './bootstrap'

async function main(): Promise<void> {
  const gateway = await bootstrapGateway()

  const stop = (signal: string): void => {
    void gateway.shutdown(signal).then(() => process.exit(0))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGHUP', () => {
    void gateway.runtime.config.reload()
  })
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', msg: 'shuttle failed to start', error: String(error) }))
  process.exit(1)
})
