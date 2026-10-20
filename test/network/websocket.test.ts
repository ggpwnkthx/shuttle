import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rawRequest } from '../../services/raw-http'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The websockets of the gateway, against a real socket.
 *
 * The handshake of the gateway happens before the answer of the caller: the
 * caller learns the outcome of the handshake of the upstream and the
 * subprotocol it selected. The origin of the handshake is checked before
 * the upstream is contacted.
 */

/** The port of the gateway, as a number. */
function portOf(url: string): number {
  return Number(new URL(url).port)
}

describe('the websockets of the gateway', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('a caller is connected to the upstream', async () => {
    const socket = new WebSocket(`ws://localhost:${portOf(harness.gatewayUrl)}/socket/`, ['chat'])
    socket.binaryType = 'arraybuffer'

    const messages: string[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the connection did not answer')), 5_000)
      socket.onmessage = (event) => {
        const payload =
          typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer)
        messages.push(payload)
        if (messages.length === 1) {
          socket.send('hello')
          return
        }
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('the connection failed'))
      }
    })

    // The upstream answers with its own greeting and with the echo of the
    // message of the caller.
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[messages.length - 1]).toBe('hello')
    // The subprotocol the upstream selected is mirrored to the caller.
    expect(socket.protocol).toBe('chat')
    socket.close()
  })

  test('a handshake of a browser with a foreign origin is refused', async () => {
    const login = await harness.login()
    const response = await rawRequest({
      port: portOf(harness.gatewayUrl),
      path: '/socket/',
      headers: {
        host: 'socket.shuttle.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin: 'https://evil.example',
        cookie: login.cookie,
      },
    })
    expect(response.status).toBe(403)
    const body = JSON.parse(response.body) as { error: string }
    expect(body.error).toBe('cross_site_request')
  })

  test('a handshake of a browser without an origin is refused', async () => {
    const login = await harness.login()
    const response = await rawRequest({
      port: portOf(harness.gatewayUrl),
      path: '/socket/',
      headers: {
        host: 'socket.shuttle.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        cookie: login.cookie,
      },
    })
    expect(response.status).toBe(403)
  })

  test('a handshake of the site itself is accepted', async () => {
    const login = await harness.login()
    const response = await rawRequest({
      port: portOf(harness.gatewayUrl),
      path: '/socket/',
      headers: {
        host: 'socket.shuttle.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin: 'http://socket.shuttle.test',
        cookie: login.cookie,
      },
    })
    expect(response.status).toBe(101)
    // The handshake answer carries the identifier of the request and the
    // refreshed cookie of the session.
    expect(response.headers['x-request-id']).toBeTruthy()
    expect(response.headers['set-cookie']).toContain('shuttle_session=')
  })

  test('a route that does not accept websockets refuses the handshake', async () => {
    const response = await rawRequest({
      port: portOf(harness.gatewayUrl),
      path: '/',
      headers: {
        host: 'public.shuttle.test',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(response.status).toBe(400)
    const body = JSON.parse(response.body) as { error: string }
    expect(body.error).toBe('websocket_not_allowed')
  })
})
