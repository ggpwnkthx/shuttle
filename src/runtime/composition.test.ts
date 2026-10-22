import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * The key of the signature of the identity.
 *
 * The signature of the identity is asymmetric: the gateway holds the
 * private key of the deployment and the upstreams hold the public one.
 * A deployment that has no `SHUTTLE_IDENTITY_SIGNING_KEY` and is not a
 * production one signs with a key that is generated for its process: the
 * format of the signature is the same, but no upstream can verify the
 * identity, and the key is neither shared by the replicas nor kept across
 * a restart.
 *
 * The gateway writes a warning when it signs that way, and the warning is
 * what an operator sees. It is written by the composition root, which
 * builds its own logger, so the warning is observed in the output of a
 * process that starts the runtime and stops it.
 */
describe('the key of the signature of the identity', () => {
  test('the gateway warns when it signs with a key of its own process', async () => {
    const script = `
      import { readEnv } from './src/runtime/env'
      import { createRuntime } from './src/runtime/composition'
      const settings = readEnv({
        SHUTTLE_CONFIG: './config/routes.dev.json',
        SHUTTLE_GATEWAY_HOST: '127.0.0.1',
        SHUTTLE_GATEWAY_PORT: '0',
        SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1',
        SHUTTLE_OIDC_CLIENT_ID: 'shuttle',
        SHUTTLE_OIDC_CLIENT_SECRET: 'secret',
        SHUTTLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:1/auth/callback',
        SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
        SHUTTLE_ACCESS_URL: 'http://127.0.0.1:1',
        SHUTTLE_SESSION_SECRET: 'secret',
        SHUTTLE_SESSION_URL: 'memory://test',
        SHUTTLE_LOG_LEVEL: 'warn',
      })
      const runtime = await createRuntime(settings)
      await runtime.drain('the test')
      await Bun.sleep(50)
      process.exit(0)
    `
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'development' },
    })
    const output = await new Response(child.stdout).text()
    await child.exited

    const warning = output
      .split('\n')
      .find((line) => line.includes('the key of the identity signature is generated'))
    expect(warning).toBeDefined()
    expect(warning).toContain('"level":"warn"')
    // The hint names the way out: the key belongs to the deployment.
    expect(warning).toContain('SHUTTLE_IDENTITY_SIGNING_KEY')
  })

  test('the gateway does not warn when the deployment has a key', async () => {
    const script = `
      import { readEnv } from './src/runtime/env'
      import { createRuntime } from './src/runtime/composition'
      import { generateKeyPairSync } from 'node:crypto'
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const settings = readEnv({
        SHUTTLE_CONFIG: './config/routes.dev.json',
        SHUTTLE_GATEWAY_HOST: '127.0.0.1',
        SHUTTLE_GATEWAY_PORT: '0',
        SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1',
        SHUTTLE_OIDC_CLIENT_ID: 'shuttle',
        SHUTTLE_OIDC_CLIENT_SECRET: 'secret',
        SHUTTLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:1/auth/callback',
        SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
        SHUTTLE_ACCESS_URL: 'http://127.0.0.1:1',
        SHUTTLE_SESSION_SECRET: 'secret',
        SHUTTLE_SESSION_URL: 'memory://test',
        SHUTTLE_LOG_LEVEL: 'warn',
        SHUTTLE_IDENTITY_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      })
      const runtime = await createRuntime(settings)
      await runtime.drain('the test')
      await Bun.sleep(50)
      process.exit(0)
    `
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'development' },
    })
    const output = await new Response(child.stdout).text()
    await child.exited

    expect(output).not.toContain('the key of the identity signature is generated')
  })
})
