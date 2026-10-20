import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The soak of the gateway.
 *
 * The test runs traffic for a while, with reloads and reconnections, and
 * checks that the resources of the process settle: the requests that are in
 * flight, the memory and the connections of the websockets. A gateway that
 * leaks grows with every request, and a deployment that is rolled out with
 * a leak runs out of memory at the worst moment.
 */
describe('the soak of the gateway', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('the resources settle after the traffic', async () => {
    const memoryBefore = process.memoryUsage().heapUsed

    // The traffic: the requests, the websockets and a reload of the
    // configuration in between.
    for (let round = 0; round < 5; round++) {
      const requests = Array.from({ length: 50 }, () =>
        fetch(`${harness.gatewayUrl}/`, { headers: { host: 'public.shuttle.test' } }).then(
          (response) => response.arrayBuffer()
        )
      )
      await Promise.all(requests)

      const socket = new WebSocket(`${harness.gatewayUrl.replace('http://', 'ws://')}/socket/`)
      await new Promise<void>((resolve) => {
        socket.onopen = () => resolve()
        socket.onerror = () => resolve()
      })
      socket.close()

      await harness.writeConfig({
        version: 1,
        defaults: { auth: { mode: 'none' } },
        routes: [
          {
            id: 'public-site',
            match: { host: 'public.shuttle.test', path: '/' },
            upstream: harness.upstreamA.url,
            auth: { mode: 'none' },
          },
        ],
      })
      await Bun.sleep(100)
    }

    // The traffic is over: everything has to settle.
    await Bun.sleep(500)
    expect(harness.runtime.exchanges.activeCount).toBe(0)
    expect(harness.runtime.websockets.connectionCount).toBe(0)

    const memoryAfter = process.memoryUsage().heapUsed
    // The memory of the process may grow a little (the caches of the
    // runtime), but it may not grow with every round of the traffic.
    const growth = memoryAfter - memoryBefore
    expect(growth).toBeLessThan(64 * 1024 * 1024)
  }, 60_000)

  test('the metrics of the gateway count the requests', async () => {
    const response = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: 'Bearer test-metrics-token' },
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('shuttle_requests_total')
    expect(body).toContain('shuttle_active_requests')
    // The gauge of the requests that are in flight is back to zero.
    const line = body.split('\n').find((entry) => entry.startsWith('shuttle_active_requests '))
    expect(line).toContain(' 0')
  })
})
