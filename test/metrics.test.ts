import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, METRICS_TOKEN, WORKSPACE_ID, type Harness } from './helpers/harness'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
  // Generate a little traffic so that the metrics have something to show.
  const login = await harness.login()
  await fetch(`${harness.gatewayUrl}/ws/${WORKSPACE_ID}/data`, {
    headers: { host: 'api.shuttle.test', cookie: login.cookie },
  })
  await fetch(`${harness.gatewayUrl}/`, { headers: { host: 'public.shuttle.test' } })
})

afterAll(async () => {
  await harness.stop()
})

describe('the metrics endpoint', () => {
  test('is not served when no token is configured', async () => {
    const token = harness.runtime.options.metricsToken
    harness.runtime.options.metricsToken = undefined
    try {
      const response = await fetch(`${harness.gatewayUrl}/metrics`, {
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
      expect(response.status).toBe(404)
    } finally {
      harness.runtime.options.metricsToken = token
    }
  })

  test('refuses a request without the token', async () => {
    const response = await fetch(`${harness.gatewayUrl}/metrics`)
    expect(response.status).toBe(401)

    const wrong = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(wrong.status).toBe(401)
  })

  test('serves the metrics in the prometheus format', async () => {
    const response = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')

    const body = await response.text()
    expect(body).toContain('# TYPE shuttle_requests_total counter')
    expect(body).toContain('shuttle_requests_total{route="workspace-api",method="GET",status="200"}')
    expect(body).toContain('shuttle_request_duration_seconds_bucket{le="0.005",route="workspace-api"}')
    expect(body).toContain('shuttle_active_requests')
  })

  test('counts the rejected callers', async () => {
    const response = await fetch(`${harness.gatewayUrl}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
    const body = await response.text()
    expect(body).toContain('shuttle_auth_failures_total')
  })
})
