import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The metrics of the requests.
 *
 * The counter is the volume of the traffic, so it has to count every
 * request the gateway answered, not only the ones that reached an
 * upstream. The labels have to stay bounded, whatever a client or an
 * upstream sends.
 */
describe('the metrics of the requests', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a refusal of the gateway is counted', async () => {
    const before = await harness.runtime.observer.render()
    const refused = await fetch(`${harness.gatewayUrl}/nothing-here`, {
      headers: { host: 'unknown.shuttle.test' },
    })
    expect(refused.status).toBe(404)
    const after = await harness.runtime.observer.render()
    expect(after).toContain('shuttle_requests_total{route="unmatched",method="GET",status="404"}')
    expect(after.length).toBeGreaterThan(before.length)
  })

  test('a request that matched a route is counted with the route', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const metrics = await harness.runtime.observer.render()
    expect(metrics).toContain(
      'shuttle_requests_total{route="public-site",method="GET",status="200"}'
    )
  })

  test('an authentication failure is counted', async () => {
    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: { host: 'api.shuttle.test' },
    })
    expect(response.status).toBe(401)
    const metrics = await harness.runtime.observer.render()
    expect(metrics).toContain(
      'shuttle_requests_total{route="workspace-api",method="GET",status="401"}'
    )
  })

  test('the status of an upstream does not grow the number of series', async () => {
    // The upstream answers with unusual statuses: they are counted
    // together, so a client or an upstream cannot create a series per
    // status.
    for (const status of [591, 592, 593, 594, 595]) {
      await fetch(`${harness.gatewayUrl}/status/${status}`, {
        headers: { host: 'public.shuttle.test' },
      })
    }
    const metrics = await harness.runtime.observer.render()
    expect(metrics).toContain(
      'shuttle_requests_total{route="public-site",method="GET",status="other"}'
    )
    expect(metrics).not.toContain('status="595"')
  })
})
