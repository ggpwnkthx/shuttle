import { describe, expect, test } from 'bun:test'
import type { UpstreamResponse } from '../../src/domains/proxying'
import { BunHttpTransport } from '../../src/platform/bun/http-transport'
import { WsUpstreamHandshake } from '../../src/platform/bun/upstream-websocket'
import { httpResponse, rawRequest, startRawHttpServer } from '../../services/raw-http'
import { startUpstream } from '../../services/upstream'

/** Reads the body of an answer of the transport. */
async function readJson(response: UpstreamResponse): Promise<unknown> {
  const text = await new Response(response.body).text()
  return JSON.parse(text)
}

/**
 * The transport capability tests.
 *
 * They run against a real socket: the runtime of the gateway is the only
 * thing that can tell whether a phase of an exchange is observable, whether
 * an upload really streams and what a protocol switch does. The rules of
 * the specification (SPECS.md §11) are only as good as these observations.
 */

const encoder = new TextEncoder()

describe('the outbound transport of Bun', () => {
  test('the upstream receives the bytes of an upload while the upload runs', async () => {
    const upstream = await startUpstream({ name: 'upload' })
    const transport = new BunHttpTransport()

    let finished = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('a'.repeat(16)))
        setTimeout(() => {
          controller.enqueue(encoder.encode('b'.repeat(16)))
          setTimeout(() => {
            finished = true
            controller.close()
          }, 150)
        }, 150)
      },
    })

    const request = transport.send({
      url: `${upstream.url}/upload?id=progress`,
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body,
      signal: AbortSignal.timeout(10_000),
    })

    // The upstream has to see the first chunk while the client is still
    // producing the body: an upload that is buffered would not.
    let seenDuringUpload = false
    for (let attempt = 0; attempt < 40; attempt++) {
      await Bun.sleep(25)
      const progress = (await (
        await fetch(`${upstream.url}/upload-progress?id=progress`)
      ).json()) as {
        chunks: unknown[]
        complete: boolean
      }
      if (progress.chunks.length > 0 && !progress.complete) {
        seenDuringUpload = true
        break
      }
    }
    expect(seenDuringUpload).toBe(true)

    const response = await request
    expect(response.status).toBe(200)
    expect(finished).toBe(true)
    await upstream.stop()
  })

  test('the end of the upload is the end of the request stream', async () => {
    const upstream = await startUpstream({ name: 'upload-end' })
    const transport = new BunHttpTransport()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('x'))
        controller.close()
      },
    })
    const response = await transport.send({
      url: `${upstream.url}/upload?id=end`,
      method: 'POST',
      headers: new Headers(),
      body,
      signal: AbortSignal.timeout(10_000),
    })
    const payload = (await readJson(response)) as { bytes: number; chunks: unknown[] }
    expect(payload.bytes).toBe(1)
    await upstream.stop()
  })

  test('the final headers and the first byte of the body are two events', async () => {
    // The raw server sends the head of the answer at once and the body a
    // second later: the two events have to be observable apart.
    const server = await startRawHttpServer(({ socket }) => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n'
      )
      setTimeout(() => {
        socket.write('5\r\nhello\r\n')
        setTimeout(() => {
          socket.write('0\r\n\r\n')
          socket.end()
        }, 50)
      }, 400)
    })
    const transport = new BunHttpTransport()
    const started = Date.now()
    const response = await transport.send({
      url: `${server.url}/`,
      method: 'GET',
      headers: new Headers(),
      body: null,
      signal: AbortSignal.timeout(10_000),
    })
    const headersAt = Date.now() - started
    expect(response.status).toBe(200)
    // The headers arrived long before the body: the answer of the upstream
    // is committed as soon as they are there.
    expect(headersAt).toBeLessThan(300)

    const reader = response.body!.getReader()
    const first = await reader.read()
    const firstAt = Date.now() - started
    expect(new TextDecoder().decode(first.value)).toBe('hello')
    expect(firstAt).toBeGreaterThanOrEqual(350)
    await server.stop()
  })

  test('an answer that arrives before the upload is over is the answer', async () => {
    const upstream = await startUpstream({ name: 'early' })
    const transport = new BunHttpTransport()
    let producerFailed = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('x'))
      },
      cancel() {
        producerFailed = true
      },
    })
    const response = await transport.send({
      url: `${upstream.url}/early`,
      method: 'POST',
      headers: new Headers(),
      body,
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(200)
    const payload = (await readJson(response)) as { early: boolean }
    expect(payload.early).toBe(true)
    // The runtime drops the rest of the upload when the upstream answered.
    await Bun.sleep(100)
    expect(producerFailed).toBe(true)
    await upstream.stop()
  })

  test('a cancelled exchange cancels the request of the upstream', async () => {
    const upstream = await startUpstream({ name: 'cancel' })
    const transport = new BunHttpTransport()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(encoder.encode('x'.repeat(64)))
        return new Promise((resolve) => setTimeout(resolve, 20))
      },
    })
    const pending = transport.send({
      url: `${upstream.url}/upload?id=cancel`,
      method: 'POST',
      headers: new Headers(),
      body,
      signal: controller.signal,
    })
    await Bun.sleep(80)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await upstream.stop()
  })

  test('a redirect of the upstream is not followed', async () => {
    const upstream = await startUpstream({ name: 'redirect' })
    const transport = new BunHttpTransport()
    const response = await transport.send({
      url: `${upstream.url}/redirect?to=%2Felsewhere`,
      method: 'GET',
      headers: new Headers(),
      body: null,
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/elsewhere')
    await upstream.stop()
  })

  test('the compressed bytes of an answer are not decompressed', async () => {
    const upstream = await startUpstream({ name: 'gzip' })
    const transport = new BunHttpTransport()
    const response = await transport.send({
      url: `${upstream.url}/gzip`,
      method: 'GET',
      headers: new Headers(),
      body: null,
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const bytes = new Uint8Array(await new Response(response.body).arrayBuffer())
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    await upstream.stop()
  })
})

describe('the answers of an upstream that are not answers', () => {
  test('an interim response is not the answer of the exchange', async () => {
    const server = await startRawHttpServer(({ socket }) => {
      socket.write('HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n')
      setTimeout(() => {
        socket.write(httpResponse(200, 'final'))
        socket.end()
      }, 40)
    })
    const transport = new BunHttpTransport()
    const response = await transport.send({
      url: `${server.url}/`,
      method: 'GET',
      headers: new Headers(),
      body: null,
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const body = await reader.read()
    expect(new TextDecoder().decode(body.value)).toBe('final')
    await server.stop()
  })

  test('a protocol switch is refused by the http path', async () => {
    const server = await startRawHttpServer(({ socket }) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
      )
      setTimeout(() => socket.end(), 20)
    })
    const transport = new BunHttpTransport()
    await expect(
      transport.send({
        url: `${server.url}/`,
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: AbortSignal.timeout(10_000),
      })
    ).rejects.toThrow()
    await server.stop()
  })

  test('an upstream that closes without an answer is a transport failure', async () => {
    const server = await startRawHttpServer(({ socket }) => {
      socket.end()
    })
    const transport = new BunHttpTransport()
    await expect(
      transport.send({
        url: `${server.url}/`,
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: AbortSignal.timeout(10_000),
      })
    ).rejects.toThrow()
    await server.stop()
  })
})

describe('the handshake with an upstream websocket', () => {
  test('the subprotocol the upstream selected is reported', async () => {
    const upstream = await startUpstream({ name: 'ws' })
    const handshake = new WsUpstreamHandshake()
    const outcome = await handshake.connect({
      url: `${upstream.url.replace('http://', 'ws://')}/ws`,
      headers: { 'x-request-id': 'req-1' },
      protocols: ['chat', 'other'],
      timeoutMs: 5_000,
    })
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') return
    expect(outcome.protocol).toBe('chat')
    outcome.socket.close(1000, 'done')
    await upstream.stop()
  })

  test('a refusal of the upstream is reported with its status and its body', async () => {
    const upstream = await startUpstream({ name: 'ws-refuse' })
    const handshake = new WsUpstreamHandshake()
    const outcome = await handshake.connect({
      url: `${upstream.url.replace('http://', 'ws://')}/ws-refuse`,
      headers: {},
      protocols: [],
      timeoutMs: 5_000,
    })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(403)
    expect(outcome.body).toContain('refused')
    await upstream.stop()
  })

  test('an upstream that does not answer is a timeout', async () => {
    const server = await startRawHttpServer(() => {
      // The connection stays open and never answers.
    })
    const handshake = new WsUpstreamHandshake()
    const outcome = await handshake.connect({
      url: `ws://127.0.0.1:${server.port}/`,
      headers: {},
      protocols: [],
      timeoutMs: 300,
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toBe('timeout')
    await server.stop()
  })
})

describe('the upgrade of the caller', () => {
  test('the handshake answer carries the headers of the gateway', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, {
          headers: {
            'x-request-id': 'req-42',
            'set-cookie': 'shuttle_session=abc; Path=/; HttpOnly',
          },
        })
        if (upgraded) return new Response(null)
        return new Response('no', { status: 400 })
      },
      websocket: {
        message() {
          /* nothing */
        },
      },
    })

    const response = await rawRequest({
      port: server.port ?? 0,
      path: '/',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(response.status).toBe(101)
    expect(response.headers['x-request-id']).toBe('req-42')
    expect(response.headers['set-cookie']).toContain('shuttle_session=abc')
    await server.stop(true)
  })
})
