import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WebSocket as NodeWebSocket } from 'ws'
import { createTestCertificates, type TestCertificates } from '../../services/certificates'
import { startUpstream, type StartedUpstream } from '../../services/upstream'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The TLS of the connections to the upstreams.
 *
 * The gateway presents the certificate of the deployment to the upstreams
 * that ask for one, and it verifies the certificate of the upstream with the
 * authority of the deployment. The certificates of the test are generated
 * when the test runs: a certificate in the repository outlives the test
 * that needs it.
 */

/** The port of the gateway, as a number. */
function portOf(url: string): number {
  return Number(new URL(url).port)
}

describe('the mutual TLS of the upstreams', () => {
  let certificates: TestCertificates
  let upstream: StartedUpstream
  let harness: Harness
  let withoutCertificate: Harness

  beforeAll(async () => {
    certificates = await createTestCertificates()
    upstream = await startUpstream({
      name: 'upstream-tls',
      tls: {
        cert: certificates.serverCert,
        key: certificates.serverKey,
        ca: certificates.ca,
        requireClientCert: true,
      },
    })
    const routes = () => [
      {
        id: 'tls-site',
        match: { host: 'tls.shuttle.test', path: '/' },
        upstream: upstream.url,
        auth: { mode: 'none' },
      },
      {
        id: 'tls-socket',
        match: { host: 'tls.shuttle.test', path: '/socket/' },
        upstream: upstream.url,
        auth: { mode: 'none' },
        websocket: true,
      },
    ]
    harness = await createHarness({
      routes,
      env: {
        SHUTTLE_UPSTREAM_TLS_CA: certificates.ca,
        SHUTTLE_UPSTREAM_TLS_CERT: certificates.clientCert,
        SHUTTLE_UPSTREAM_TLS_KEY: certificates.clientKey,
      },
    })
    // The same deployment without the certificate of the gateway: the
    // upstream refuses the handshake.
    withoutCertificate = await createHarness({
      routes,
      env: { SHUTTLE_UPSTREAM_TLS_CA: certificates.ca },
    })
  })

  afterAll(async () => {
    await harness.stop()
    await withoutCertificate.stop()
    await upstream.stop()
    await certificates.cleanup()
  })

  test('the gateway reaches an upstream that asks for a certificate', async () => {
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'tls.shuttle.test' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string }
    expect(body.service).toBe('upstream-tls')
  })

  test('an upstream that refuses the certificate is a 502', async () => {
    const response = await fetch(`${withoutCertificate.gatewayUrl}/`, {
      headers: { host: 'tls.shuttle.test' },
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('bad_gateway')
  })

  test('the handshake of a websocket over TLS is refused with a reason', async () => {
    // The websocket client of the runtime cannot speak TLS: the gateway
    // says so instead of failing with an error that hides the cause.
    const socket = new NodeWebSocket(`ws://localhost:${portOf(harness.gatewayUrl)}/socket/`, {
      headers: { host: 'tls.shuttle.test' },
    })
    const failure = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the connection did not answer')), 5_000)
      socket.on('unexpected-response', (_request: unknown, response: { statusCode: number }) => {
        clearTimeout(timer)
        resolve({ status: response.statusCode, body: '' })
      })
      socket.on('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    expect(failure.status).toBe(502)
  })
})
