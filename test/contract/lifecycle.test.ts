import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rename, writeFile } from 'node:fs/promises'
import { watchConfiguration } from '../../src/runtime/lifecycle'
import { createHarness, type Harness } from './harness'

/**
 * The lifecycle of the gateway.
 *
 * The configuration is watched, a broken file never takes a running
 * deployment out of rotation and the shutdown closes what is left within
 * the deadline of the deployment.
 */
describe('the reload of the configuration', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a new configuration is published', async () => {
    const watcher = watchConfiguration({
      store: harness.runtime.config,
      logger: harness.runtime.logger,
      observer: harness.runtime.observer,
      path: harness.configPath,
      debounceMs: 50,
    })
    await watcher.ready
    try {
      const before = harness.runtime.config.revision
      await writeFile(
        harness.configPath,
        JSON.stringify(
          {
            version: 1,
            defaults: { auth: { mode: 'none' } },
            routes: [
              {
                id: 'other-site',
                match: { host: 'other.shuttle.test', path: '/' },
                upstream: harness.upstreamA.url,
                auth: { mode: 'none' },
              },
            ],
          },
          null,
          2
        )
      )
      await waitFor(() => harness.runtime.config.revision > before)

      // The new route answers, the old one does not.
      const response = await fetch(`${harness.gatewayUrl}/`, {
        headers: { host: 'other.shuttle.test' },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { service: string }
      expect(body.service).toBe('upstream-a')
    } finally {
      watcher.stop()
    }
  })

  test('a broken file keeps the last good configuration', async () => {
    const watcher = watchConfiguration({
      store: harness.runtime.config,
      logger: harness.runtime.logger,
      observer: harness.runtime.observer,
      path: harness.configPath,
      debounceMs: 50,
    })
    await watcher.ready
    try {
      const before = harness.runtime.config.revision
      await writeFile(harness.configPath, '{ this is not json')
      await waitFor(() => harness.runtime.config.lastError !== null)

      // The last good configuration is still the running one.
      expect(harness.runtime.config.revision).toBe(before)
      const response = await fetch(`${harness.gatewayUrl}/`, {
        headers: { host: 'other.shuttle.test' },
      })
      expect(response.status).toBe(200)

      // The readiness reports the error of the reload.
      const ready = await fetch(`${harness.gatewayUrl}/readyz`)
      const body = (await ready.json()) as {
        status: string
        config: { lastError: { message: string } | null }
      }
      expect(body.status).toBe('ready')
      expect(body.config.lastError).not.toBeNull()
    } finally {
      watcher.stop()
    }
  })

  test('a file that is replaced is noticed', async () => {
    const watcher = watchConfiguration({
      store: harness.runtime.config,
      logger: harness.runtime.logger,
      observer: harness.runtime.observer,
      path: harness.configPath,
      debounceMs: 50,
    })
    await watcher.ready
    try {
      const before = harness.runtime.config.revision
      const replacement = `${harness.configPath}.new`
      await writeFile(
        replacement,
        JSON.stringify({
          version: 1,
          defaults: { auth: { mode: 'none' } },
          routes: [
            {
              id: 'replaced-site',
              match: { host: 'replaced.shuttle.test', path: '/' },
              upstream: harness.upstreamA.url,
              auth: { mode: 'none' },
            },
          ],
        })
      )
      await rename(replacement, harness.configPath)
      await waitFor(() => harness.runtime.config.revision > before)
      expect(harness.runtime.config.revision).toBeGreaterThan(before)
    } finally {
      watcher.stop()
    }
  })
})

describe('the shutdown of the gateway', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a stream that is running is closed by the drain', async () => {
    // The upstream streams events for a long time; the drain has to close
    // the exchange instead of waiting for it.
    const streaming = fetch(`${harness.gatewayUrl}/sse?count=1000&delay=100`, {
      headers: { host: 'public.shuttle.test' },
    }).catch(() => null)
    await waitFor(() => harness.runtime.exchanges.activeCount > 0)

    const draining = harness.runtime.drain('SIGTERM')
    await waitFor(() => harness.runtime.isDraining())
    await draining

    const response = await streaming
    expect(response === null || response.status >= 200).toBe(true)
    // Nothing is left running.
    expect(harness.runtime.exchanges.activeCount).toBe(0)
  })

  test('the gateway stops accepting new work', async () => {
    const draining = harness.runtime.drain('SIGTERM')
    await waitFor(() => harness.runtime.isDraining())
    const ready = await fetch(`${harness.gatewayUrl}/readyz`).catch(() => null)
    // The listener may already be closed: the readiness answers 503 or the
    // connection is refused, never a ready answer.
    if (ready) {
      expect(ready.status).toBe(503)
    }
    await draining
    // Nothing is left running.
    expect(harness.runtime.exchanges.activeCount).toBe(0)
  })
})

/** Waits until a condition holds. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('the condition did not hold in time')
    }
    await Bun.sleep(25)
  }
}
