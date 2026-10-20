import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
})

afterAll(async () => {
  await harness.stop()
})

describe('configuration reload', () => {
  test('an invalid configuration is rejected and the previous one stays active', async () => {
    const login = await harness.login()

    await harness.writeConfig({
      version: 1,
      routes: [{ id: 'broken', match: { host: 'api.shuttle.test', path: '/' } }],
    })

    const result = await harness.runtime.config.reload()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('the configuration should be invalid')
    expect(result.error.message).toContain('invalid configuration')

    // The previous configuration is still serving traffic.
    const proxied = await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(proxied.status).toBe(200)

    // The failure is reported in the status of the configuration.
    const status = harness.runtime.config.status()
    expect(status.lastError).not.toBeNull()
    expect(status.revision).toBe(1)
  })

  test('a valid configuration is applied', async () => {
    await harness.writeConfig({
      version: 1,
      routes: [
        {
          id: 'reloaded-route',
          match: { host: 'reloaded.shuttle.test', path: '/' },
          upstream: harness.upstreamA.url,
          auth: { mode: 'none' },
        },
      ],
    })

    const result = await harness.runtime.config.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('the configuration should be valid')
    expect(result.revision).toBe(2)

    const proxied = await fetch(`${harness.gatewayUrl}/anything`, {
      headers: { host: 'reloaded.shuttle.test' },
    })
    expect(proxied.status).toBe(200)
  })

  test('the configuration file is watched for changes', async () => {
    harness.runtime.config.watchForChanges(50)
    await harness.writeConfig({
      version: 1,
      routes: [
        {
          id: 'watched-route',
          match: { host: 'watched.shuttle.test', path: '/' },
          upstream: harness.upstreamA.url,
          auth: { mode: 'none' },
        },
      ],
    })
    await Bun.sleep(600)
    const proxied = await fetch(`${harness.gatewayUrl}/anything`, {
      headers: { host: 'watched.shuttle.test' },
    })
    expect(proxied.status).toBe(200)
  })
})
