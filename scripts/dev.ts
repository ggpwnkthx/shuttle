#!/usr/bin/env bun
/**
 * The development runner.
 *
 * It starts everything that is needed to work on Shuttle locally in a
 * single process:
 *
 *   - the identity provider   (the `oidc-provider` package, on :5556)
 *   - the access fixture      (:8090)
 *   - two sample upstreams    (:3000 and :3001)
 *   - the gateway itself      (:8080)
 *
 * The gateway is started through the same runtime as the container uses, so
 * the two behave the same. A change in the configuration is picked up by the
 * gateway itself, a change in the code restarts the process.
 */
import { readEnv } from '../src/runtime/env'
import { createRuntime } from '../src/runtime/composition'
import { watchConfiguration } from '../src/runtime/lifecycle'
import { startAccessService } from '../services/access-fixture'
import { startOidcProvider } from '../services/oidc-provider'
import { startUpstream } from '../services/upstream'

const GATEWAY_PORT = 8080
const IDP_PORT = 5556
const ACCESS_PORT = 8090
const UPSTREAM_A_PORT = 3000
const UPSTREAM_B_PORT = 3001

const OIDC_CLIENT_ID = 'shuttle'
const OIDC_CLIENT_SECRET = 'shuttle-secret'
const OIDC_REDIRECT_URI = `http://localhost:${GATEWAY_PORT}/auth/callback`

const DEV_ENV: Record<string, string> = {
  SHUTTLE_CONFIG: './config/routes.dev.json',
  SHUTTLE_GATEWAY_PORT: String(GATEWAY_PORT),
  SHUTTLE_GATEWAY_HOST: '127.0.0.1',
  SHUTTLE_OIDC_ISSUER: `http://localhost:${IDP_PORT}`,
  SHUTTLE_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
  SHUTTLE_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
  SHUTTLE_OIDC_REDIRECT_URI: OIDC_REDIRECT_URI,
  SHUTTLE_OIDC_SCOPES: 'openid,profile,email',
  SHUTTLE_ACCESS_URL: `http://localhost:${ACCESS_PORT}`,
  SHUTTLE_SESSION_SECRET: 'shuttle-development-secret',
  SHUTTLE_COOKIE_SECURE: 'false',
  SHUTTLE_EXTERNAL_PROTO: 'http',
  SHUTTLE_LOG_LEVEL: 'info',
}

async function main(): Promise<void> {
  // The development runner starts the fixtures, and the fixtures refuse to
  // run in a production environment.
  process.env.NODE_ENV = 'development'

  const idp = await startOidcProvider({
    port: IDP_PORT,
    issuer: `http://localhost:${IDP_PORT}`,
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    redirectUris: [OIDC_REDIRECT_URI],
  })

  const access = await startAccessService({ port: ACCESS_PORT })
  const upstreamA = await startUpstream({ name: 'upstream-a', port: UPSTREAM_A_PORT })
  const upstreamB = await startUpstream({ name: 'upstream-b', port: UPSTREAM_B_PORT })

  const settings = readEnv({ ...process.env, ...DEV_ENV })
  const runtime = await createRuntime(settings)
  const config = await Bun.file(settings.configPath).text()
  const loaded = runtime.config.applyText(config)
  if (!loaded.ok) {
    runtime.logger.error('the configuration of the development stack is invalid', {
      error: loaded.error,
    })
  }

  const watcher = watchConfiguration({
    store: runtime.config,
    logger: runtime.logger,
    observer: runtime.observer,
    path: settings.configPath,
  })
  await watcher.ready

  console.log('')
  console.log('  Shuttle is starting up')
  console.log('  ─────────────────────────────────────────────')
  console.log(`  gateway        http://localhost:${GATEWAY_PORT}`)
  console.log(`  identity       ${idp.issuer}`)
  console.log('')
  console.log('  sign in with   alice@shuttle.test / alice-password')
  console.log('  workspace      11111111-1111-4111-8111-111111111111')
  console.log(`  public route   http://localhost:${GATEWAY_PORT}/`)
  console.log(
    `  workspace API  http://localhost:${GATEWAY_PORT}/ws/11111111-1111-4111-8111-111111111111/`
  )
  console.log('')

  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    await runtime.drain(signal)
    watcher.stop()
    await runtime.close()
    await Promise.all([idp.stop(), access.stop(), upstreamA.stop(), upstreamB.stop()])
    process.exit(0)
  }

  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'the development stack could not be started',
      error: error instanceof Error ? error.message : String(error),
    })
  )
  process.exit(1)
})
