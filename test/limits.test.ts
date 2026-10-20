import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WebSocket as ClientWebSocket } from 'ws'
import { createHarness, WORKSPACE_ID, type Harness } from './helpers/harness'

/**
 * The limits of the gateway: the number of requests a caller may make, the
 * number of login attempts and the number of websocket connections.
 *
 * Every limit gets its own gateway, so the tests do not use up the window
 * of each other.
 */

describe('the request limiter', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ rateLimitMax: 5 })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('refuses the requests that are over the limit', async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(`${harness.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      statuses.push(response.status)
    }
    expect(statuses[0]).toBe(200)
    expect(statuses).toContain(429)
  })

  test('the refused request carries the time to wait', async () => {
    // The window of the limiter is a minute, the earlier requests of the
    // test used it up, so this request is over the limit as well.
    const response = await fetch(`${harness.gatewayUrl}/`, {
      headers: { host: 'public.shuttle.test' },
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('too_many_requests')
  })

  test('a limiter that is not configured lets every request pass', async () => {
    const open = await createHarness({ rateLimitMax: 0 })
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`${open.gatewayUrl}/`, {
          headers: { host: 'public.shuttle.test' },
        })
        expect(response.status).toBe(200)
      }
    } finally {
      await open.stop()
    }
  })
})

describe('the login limiter', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ loginRateLimitMax: 3 })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('refuses the login attempts that are over the limit', async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${harness.gatewayUrl}/auth/login`, { redirect: 'manual' })
      statuses.push(response.status)
    }
    expect(statuses[0]).toBe(302)
    expect(statuses).toContain(429)
  })
})

describe('the websocket connection limit', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({ websocketMaxConnections: 1 })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('refuses the connections that are over the limit', async () => {
    const token = await harness.token()
    const port = new URL(harness.gatewayUrl).port
    const first = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve, reject) => {
      first.once('open', () => resolve())
      first.once('error', reject)
    })

    const second = await new Promise<number | undefined>((resolve) => {
      const socket = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
        headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
      })
      socket.once('open', () => resolve(undefined))
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode)
        socket.close()
      })
      socket.on('error', () => resolve(undefined))
    })
    expect(second).toBe(503)
    first.close()
  })

  test('gives the slot back when a connection is closed', async () => {
    const token = await harness.token()
    const port = new URL(harness.gatewayUrl).port
    const socket = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.close()
    })
    // The slot of the closed connection is free again.
    await Bun.sleep(100)

    const second = await new Promise<number | undefined>((resolve) => {
      const next = new ClientWebSocket(`ws://localhost:${port}/ws/${WORKSPACE_ID}/ws`, {
        headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
      })
      next.once('open', () => resolve(undefined))
      next.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode)
        next.close()
      })
      next.on('error', () => resolve(undefined))
    })
    expect(second).toBeUndefined()
  })
})
