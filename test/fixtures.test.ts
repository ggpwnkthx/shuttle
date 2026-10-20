import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { startAccessService } from '../services/access-fixture'
import { startOidcProvider } from '../services/oidc-provider'
import { assertFixtureAllowed, FixtureInProductionError } from '../services/fixture-guard'

/**
 * The development fixtures must never end up in a deployment.
 *
 * The identity provider fixture holds accounts with known passwords and the
 * access fixture makes authorization decisions with a static policy. Both are
 * excluded from the production image and both refuse to start when the
 * environment says it is a production one.
 */

async function withNodeEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV
  if (value === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
}

describe('the development fixtures', () => {
  test('the identity provider refuses to start in production', async () => {
    await withNodeEnv('production', async () => {
      await expect(startOidcProvider()).rejects.toBeInstanceOf(FixtureInProductionError)
    })
  })

  test('the access service refuses to start in production', async () => {
    await withNodeEnv('production', async () => {
      await expect(startAccessService()).rejects.toBeInstanceOf(FixtureInProductionError)
    })
  })

  test('the fixtures start in a development and in a test environment', async () => {
    for (const environment of ['development', 'test', undefined]) {
      await withNodeEnv(environment, async () => {
        const idp = await startOidcProvider()
        const access = await startAccessService()
        await idp.stop()
        await access.stop()
      })
    }
  })

  test('the guard only refuses a production environment', () => {
    expect(() => assertFixtureAllowed('identity provider', {})).not.toThrow()
    expect(() => assertFixtureAllowed('identity provider', { NODE_ENV: 'test' })).not.toThrow()
    expect(() => assertFixtureAllowed('identity provider', { NODE_ENV: 'production' })).toThrow(
      FixtureInProductionError
    )
  })
})

describe('the production image', () => {
  test('does not contain the fixtures', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
    const stages = dockerfile.split(/^FROM\s+/m).slice(1)
    const runtime = stages.find((stage) => /^.*AS runtime\b/.test(stage))
    expect(runtime).toBeDefined()

    // Neither the fixtures nor the development runner may be copied into the
    // image that runs the gateway.
    expect(runtime!).not.toMatch(/^\s*COPY\s+services\b/m)
    expect(runtime!).not.toMatch(/^\s*COPY\s+scripts\b/m)
  })

  test('has a separate stage for the fixtures', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toMatch(/AS fixtures\b/)
    expect(dockerfile).toMatch(/NODE_ENV=production/)
  })
})
