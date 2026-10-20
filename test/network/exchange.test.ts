import { describe, expect, test } from 'bun:test'
import { HttpExchangeService } from '../../src/domains/proxying'
import { BunHttpTransport } from '../../src/platform/bun/http-transport'
import { startRawHttpServer } from '../../services/raw-http'
import { startUpstream, type StartedUpstream } from '../../services/upstream'

/**
 * The exchanges against a real upstream.
 *
 * The rules of the specification about the phases, about the limits and
 * about the commitment of the answer are only meaningful on a real socket:
 * these tests run against a server that really reads the body, really
 * streams an answer and really goes away.
 */

/** The budgets of the tests. */
const timeouts = { responseMs: 5_000, firstByteMs: 5_000, bodyMs: 5_000 }

/** A service of the exchanges that talks to a real upstream. */
function service(): HttpExchangeService {
  return new HttpExchangeService({ transport: new BunHttpTransport() })
}

/** The request of a test. */
function request(
  upstream: StartedUpstream,
  path: string,
  options: {
    method?: string
    body?: ReadableStream<Uint8Array> | null
    headers?: Headers
    signal?: AbortSignal
    maxBodyBytes?: number
    timeouts?: typeof timeouts
  } = {}
) {
  return {
    method: options.method ?? 'GET',
    url: `${upstream.url}${path}`,
    headers: options.headers ?? new Headers(),
    body: options.body ?? null,
    signal: options.signal ?? new AbortController().signal,
    timeouts: options.timeouts ?? timeouts,
    maxBodyBytes: options.maxBodyBytes ?? 0,
  }
}

describe('the exchanges of a real upstream', () => {
  test('an answer that streams is handed over as it comes', async () => {
    const upstream = await startUpstream({ name: 'sse' })
    const result = await service().execute(request(upstream, '/sse?count=3&delay=20'))
    expect(result.failure).toBeNull()
    expect(result.response?.status).toBe(200)
    const text = await new Response(result.response!.body!).text()
    expect(text).toContain('event: message')
    expect(result.outcome).toBe('complete')
    expect(result.bytesOut).toBeGreaterThan(0)
    await upstream.stop()
  })

  test('an answer without a body is forwarded as it is', async () => {
    const upstream = await startUpstream({ name: 'bodyless' })
    const result = await service().execute(request(upstream, '/status/204'))
    expect(result.response?.status).toBe(204)
    expect(result.response?.body).toBeNull()
    expect(result.outcome).toBe('complete')
    await upstream.stop()
  })

  test('the compressed bytes of an answer are not decompressed', async () => {
    const upstream = await startUpstream({ name: 'gzip' })
    const result = await service().execute(request(upstream, '/gzip'))
    expect(result.response?.headers.get('content-encoding')).toBe('gzip')
    const bytes = new Uint8Array(await new Response(result.response!.body!).arrayBuffer())
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    await upstream.stop()
  })

  test('a redirect of the upstream is not followed', async () => {
    const upstream = await startUpstream({ name: 'redirect' })
    const result = await service().execute(request(upstream, '/redirect?to=%2Felsewhere'))
    expect(result.response?.status).toBe(302)
    expect(result.response?.headers.get('location')).toBe('/elsewhere')
    await upstream.stop()
  })

  test('a body that is over the limit is refused before the answer', async () => {
    const upstream = await startUpstream({ name: 'limit' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(64)))
        controller.enqueue(new TextEncoder().encode('b'.repeat(64)))
        controller.close()
      },
    })
    const result = await service().execute(
      request(upstream, '/upload', { method: 'POST', body, maxBodyBytes: 32 })
    )
    expect(result.failure?.kind).toBe('too_large')
    expect(result.response).toBeNull()
    await upstream.stop()
  })

  test('an answer that arrives before the upload is over is the answer', async () => {
    const upstream = await startUpstream({ name: 'early' })
    let produced = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1
        controller.enqueue(new TextEncoder().encode('a'.repeat(16)))
        if (produced > 100) controller.close()
      },
    })
    const result = await service().execute(
      request(upstream, '/early', { method: 'POST', body, maxBodyBytes: 32 })
    )
    // The answer of the upstream was committed: the caller gets it, even
    // though the upload was over the limit.
    expect(result.response?.status).toBe(200)
    expect(result.failure).toBeNull()
    await upstream.stop()
  })

  test('a caller that goes away cancels the request of the upstream', async () => {
    const upstream = await startUpstream({ name: 'disconnect' })
    const controller = new AbortController()
    const exchanges = service()
    const pending = exchanges.execute(
      request(upstream, '/upload?id=disconnect', {
        method: 'POST',
        signal: controller.signal,
        body: new ReadableStream<Uint8Array>({
          pull(streamController) {
            streamController.enqueue(new TextEncoder().encode('a'.repeat(16)))
            return new Promise((resolve) => setTimeout(resolve, 50))
          },
        }),
      })
    )
    await Bun.sleep(80)
    controller.abort()
    const result = await pending
    expect(result.failure?.kind).toBe('aborted')
    // The exchange is over: nothing is left running.
    await Bun.sleep(20)
    expect(exchanges.activeCount).toBe(0)
    await upstream.stop()
  })

  test('an upstream that never sends the first byte ends the body', async () => {
    // The raw server sends the head of the answer at once and the body much
    // later: the budget of the first byte has to end the body.
    const server = await startRawHttpServer(({ socket }) => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n'
      )
    })
    const result = await service().execute({
      method: 'GET',
      url: `${server.url}/`,
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts: { ...timeouts, firstByteMs: 150 },
      maxBodyBytes: 0,
    })
    expect(result.response?.status).toBe(200)
    // The status line was already sent: the body ends instead of the answer
    // being replaced by an error.
    await expect(new Response(result.response!.body!).text()).rejects.toThrow()
    expect(result.outcome).toBe('aborted')
    await server.stop()
  })

  test('an upstream that does not answer in time is a timeout', async () => {
    const upstream = await startUpstream({ name: 'slow' })
    const result = await service().execute(
      request(upstream, '/delay-headers?ms=5000', {
        timeouts: { ...timeouts, responseMs: 150 },
      })
    )
    expect(result.failure?.kind).toBe('timeout')
    expect(result.response).toBeNull()
    await upstream.stop()
  })
})
