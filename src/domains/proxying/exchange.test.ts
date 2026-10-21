import { describe, expect, test } from 'bun:test'
import { HttpExchangeService, expectsBody } from './index'
import type { HttpTransport, UpstreamRequest, UpstreamResponse } from './transport'

/** A transport that answers what the test needs. */
function transport(options: {
  respond?: (request: UpstreamRequest) => Promise<UpstreamResponse> | UpstreamResponse
  fail?: Error
  delayMs?: number
}): HttpTransport {
  return {
    async send(request) {
      if (options.delayMs) await Bun.sleep(options.delayMs)
      if (options.fail) throw options.fail
      if (options.respond) return await options.respond(request)
      return {
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: null,
      }
    },
  }
}

/** A body that produces the given chunks. */
function bodyOf(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) await Bun.sleep(delayMs)
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

/** The budgets of the tests. */
const timeouts = { responseMs: 1_000, firstByteMs: 1_000, bodyMs: 1_000 }

describe('the answer of an upstream', () => {
  test('an answer without a body is complete', async () => {
    const service = new HttpExchangeService({ transport: transport({}) })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(result.failure).toBeNull()
    expect(result.response?.status).toBe(200)
    expect(result.outcome).toBe('complete')
    expect(result.bytesIn).toBe(0)
  })

  test('the bytes of the answer are counted', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: () => ({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          body: bodyOf(['hello', 'world']),
        }),
      }),
    })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    const text = await new Response(result.response!.body!).text()
    expect(text).toBe('helloworld')
    expect(result.bytesOut).toBe(10)
    expect(result.outcome).toBe('complete')
  })

  test('the bytes of the request are counted', async () => {
    let seen = 0
    const service = new HttpExchangeService({
      transport: transport({
        respond: async (request) => {
          const reader = request.body instanceof Uint8Array ? null : request.body?.getReader()
          while (reader) {
            const { done, value } = await reader.read()
            if (done) break
            seen += value?.byteLength ?? 0
          }
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: bodyOf(['abc', 'de']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(seen).toBe(5)
    expect(result.bytesIn).toBe(5)
  })
})

describe('the limit of the body', () => {
  test('a body that is announced over the limit is refused before it is sent', async () => {
    let sent = false
    const service = new HttpExchangeService({
      transport: transport({
        respond: () => {
          sent = true
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers({ 'content-length': '100' }),
      body: bodyOf(['x']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 10,
    })
    expect(result.failure?.kind).toBe('too_large')
    expect(sent).toBe(false)
  })

  test('a body that is over the limit while it streams is refused', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: async (request) => {
          const reader = request.body instanceof Uint8Array ? null : request.body?.getReader()
          while (reader) {
            const { done } = await reader.read()
            if (done) break
          }
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: bodyOf(['aaaaa', 'bbbbb', 'ccccc']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 6,
    })
    expect(result.failure?.kind).toBe('too_large')
  })

  test('a limit of zero disables the limit', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: async (request) => {
          const reader = request.body instanceof Uint8Array ? null : request.body?.getReader()
          while (reader) {
            const { done } = await reader.read()
            if (done) break
          }
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: bodyOf(['a'.repeat(1000)]),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(result.failure).toBeNull()
    expect(result.bytesIn).toBe(1000)
  })
})

describe('the budgets of the phases', () => {
  test('an upstream that does not answer in time is a timeout', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: () =>
          new Promise<UpstreamResponse>(() => {
            /* the upstream never answers */
          }),
      }),
    })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts: { ...timeouts, responseMs: 100 },
      maxBodyBytes: 0,
    })
    expect(result.failure?.kind).toBe('timeout')
    expect(result.response).toBeNull()
  })

  test('an upload that does not make progress is cut off', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: async (request) => {
          const reader = request.body instanceof Uint8Array ? null : request.body?.getReader()
          while (reader) {
            const { done } = await reader.read()
            if (done) break
          }
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'))
        // The client stops sending.
      },
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: stalled,
      signal: new AbortController().signal,
      timeouts: { ...timeouts, bodyMs: 100 },
      maxBodyBytes: 0,
    })
    expect(result.failure?.kind).toBe('timeout')
  })

  test('the budget of the answer starts when the upload is over', async () => {
    let answeredAt = 0
    const service = new HttpExchangeService({
      transport: transport({
        respond: async (request) => {
          const reader = request.body instanceof Uint8Array ? null : request.body?.getReader()
          while (reader) {
            const { done } = await reader.read()
            if (done) break
          }
          answeredAt = Date.now()
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        },
      }),
    })
    const started = Date.now()
    const slowUpload = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('a'))
        await Bun.sleep(300)
        controller.close()
      },
    })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: slowUpload,
      signal: new AbortController().signal,
      // The budget of the answer is short, but the upload is not part of it.
      timeouts: { ...timeouts, responseMs: 200, bodyMs: 1_000 },
      maxBodyBytes: 0,
    })
    expect(result.failure).toBeNull()
    expect(answeredAt - started).toBeGreaterThanOrEqual(250)
  })

  test('an answer without a body has no first byte to wait for', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: () => ({
          status: 204,
          statusText: 'No Content',
          headers: new Headers(),
          body: null,
        }),
      }),
    })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts: { ...timeouts, firstByteMs: 50 },
      maxBodyBytes: 0,
    })
    expect(result.response?.status).toBe(204)
    expect(result.outcome).toBe('complete')
    expect(expectsBody('GET', 204)).toBe(false)
    expect(expectsBody('HEAD', 200)).toBe(false)
    expect(expectsBody('GET', 200)).toBe(true)
  })
})

describe('the cancellation of an exchange', () => {
  test('a caller that goes away cancels the request of the upstream', async () => {
    let aborted = false
    const service = new HttpExchangeService({
      transport: transport({
        respond: (request) =>
          new Promise<UpstreamResponse>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          }),
      }),
    })
    const controller = new AbortController()
    const pending = service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: controller.signal,
      timeouts,
      maxBodyBytes: 0,
    })
    await Bun.sleep(20)
    controller.abort()
    const result = await pending
    expect(result.failure?.kind).toBe('aborted')
    expect(aborted).toBe(true)
  })

  test('an upstream that cannot be reached is a network failure', async () => {
    const service = new HttpExchangeService({
      transport: transport({ fail: new Error('the connection is closed') }),
    })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(result.failure?.kind).toBe('network')
  })
})

describe('the finalization of an exchange', () => {
  test('the exchange is finalized exactly once', async () => {
    let finalized = 0
    const service = new HttpExchangeService({
      transport: transport({
        respond: () => ({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          body: bodyOf(['a', 'b']),
        }),
      }),
      onFinalize: () => {
        finalized += 1
      },
    })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    await new Response(result.response!.body!).text()
    await Bun.sleep(20)
    expect(finalized).toBe(1)
    expect(service.activeCount).toBe(0)
  })

  test('the exchanges that are running can be stopped', async () => {
    const service = new HttpExchangeService({
      transport: transport({
        respond: (request) =>
          new Promise<UpstreamResponse>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      }),
    })
    void service.execute({
      method: 'GET',
      urls: ['http://upstream.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    await Bun.sleep(20)
    expect(service.activeCount).toBe(1)
    expect(service.abortAll()).toBe(1)
    await Bun.sleep(20)
    expect(service.activeCount).toBe(0)
  })
})

describe('the upstreams of a route', () => {
  /** A transport that records the urls it was asked for. */
  function recorder(options: { failOn: (url: string) => boolean }) {
    const urls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        urls.push(request.url)
        if (options.failOn(request.url)) throw new Error('the connection is refused')
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    return { urls, transport }
  }

  test('the next upstream is tried when the connection to the first one fails', async () => {
    const upstream = recorder({ failOn: (url) => url.includes('first') })
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(upstream.urls).toEqual(['http://first.test/', 'http://second.test/'])
    expect(result.response?.status).toBe(200)
    expect(result.failure).toBeNull()
  })

  test('a request that changes the state of an upstream is not sent twice', async () => {
    const upstream = recorder({ failOn: (url) => url.includes('first') })
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(upstream.urls).toEqual(['http://first.test/'])
    expect(result.failure?.kind).toBe('network')
  })

  test('a request that has a body is not sent twice', async () => {
    const upstream = recorder({ failOn: (url) => url.includes('first') })
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(upstream.urls).toEqual(['http://first.test/'])
    expect(result.failure?.kind).toBe('network')
  })

  test('an upstream that answers is not followed by another one', async () => {
    const upstream = recorder({ failOn: () => false })
    const service = new HttpExchangeService({ transport: upstream.transport })
    await service.execute({
      method: 'GET',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(upstream.urls).toEqual(['http://first.test/'])
  })

  test('the last upstream that fails is the failure of the request', async () => {
    const upstream = recorder({ failOn: () => true })
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
    })
    expect(upstream.urls).toEqual(['http://first.test/', 'http://second.test/'])
    expect(result.failure?.kind).toBe('network')
    expect(result.response).toBeNull()
  })
})

describe('the failover of a route', () => {
  /** A transport that records the bodies it received. */
  function bodies(): {
    seen: { url: string; body: string }[]
    transport: HttpTransport
    failOn: (url: string) => boolean
  } {
    const seen: { url: string; body: string }[] = []
    const state = { failOn: (url: string) => url.includes('first') }
    const transport: HttpTransport = {
      async send(request) {
        const body =
          request.body instanceof Uint8Array
            ? new TextDecoder().decode(request.body)
            : await new Response(request.body as ReadableStream).text()
        seen.push({ url: request.url, body })
        if (state.failOn(request.url)) throw new Error('the connection is refused')
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    return { seen, transport, failOn: (url) => state.failOn(url) }
  }

  test('a route with one upstream streams the body, so the upstream is reached while the caller uploads', async () => {
    let streamed = false
    const transport: HttpTransport = {
      async send(request) {
        streamed = !(request.body instanceof Uint8Array)
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    const service = new HttpExchangeService({ transport })
    await service.execute({
      method: 'PUT',
      urls: ['http://only.test/'],
      headers: new Headers({ 'content-length': '5' }),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      replayMaxBytes: 1024,
    })
    expect(streamed).toBe(true)
  })

  test('a body that fits is sent again to the next upstream', async () => {
    const upstream = bodies()
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'PUT',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers({ 'content-length': '5' }),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      replayMaxBytes: 1024,
    })
    expect(upstream.seen.map((entry) => entry.url)).toEqual([
      'http://first.test/',
      'http://second.test/',
    ])
    // The body reached both upstreams: it was held in memory.
    expect(upstream.seen.map((entry) => entry.body)).toEqual(['hello', 'hello'])
    expect(result.response?.status).toBe(200)
  })

  test('a body that does not fit is not sent again', async () => {
    const upstream = bodies()
    const service = new HttpExchangeService({ transport: upstream.transport })
    const result = await service.execute({
      method: 'PUT',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers({ 'content-length': '5' }),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      replayMaxBytes: 2,
    })
    expect(upstream.seen.map((entry) => entry.url)).toEqual(['http://first.test/'])
    expect(result.failure?.kind).toBe('network')
  })

  test('a replay of zero disables the sending of a body again', async () => {
    const upstream = bodies()
    const service = new HttpExchangeService({ transport: upstream.transport })
    await service.execute({
      method: 'PUT',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers({ 'content-length': '5' }),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      replayMaxBytes: 0,
    })
    expect(upstream.seen.map((entry) => entry.url)).toEqual(['http://first.test/'])
  })

  test('a request that changes the state of an upstream is not sent again, whatever the body', async () => {
    const upstream = bodies()
    const service = new HttpExchangeService({ transport: upstream.transport })
    await service.execute({
      method: 'POST',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers({ 'content-length': '5' }),
      body: bodyOf(['hello']),
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      replayMaxBytes: 1024,
    })
    expect(upstream.seen.map((entry) => entry.url)).toEqual(['http://first.test/'])
  })

  test('an upstream that does not answer in time is left for the next one', async () => {
    const urls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        urls.push(request.url)
        if (request.url.includes('first')) {
          // The upstream accepted the connection and never answers.
          await new Promise((resolve) => setTimeout(resolve, 5_000))
          return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
        }
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    const service = new HttpExchangeService({ transport })
    const started = Date.now()
    const result = await service.execute({
      method: 'GET',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      upstreamAttemptMs: 150,
    })
    expect(urls).toEqual(['http://first.test/', 'http://second.test/'])
    expect(result.response?.status).toBe(200)
    // The attempt was abandoned after its budget, not after the whole
    // budget of the answer.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('the budget of an attempt does not apply to the last upstream', async () => {
    const transport: HttpTransport = {
      async send() {
        await new Promise((resolve) => setTimeout(resolve, 400))
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    const service = new HttpExchangeService({ transport })
    const result = await service.execute({
      method: 'GET',
      urls: ['http://only.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      upstreamAttemptMs: 50,
    })
    expect(result.response?.status).toBe(200)
  })

  test('the budget of an attempt does not apply to a request that may not be sent twice', async () => {
    const urls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        urls.push(request.url)
        await new Promise((resolve) => setTimeout(resolve, 400))
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null }
      },
    }
    const service = new HttpExchangeService({ transport })
    const result = await service.execute({
      method: 'POST',
      urls: ['http://first.test/', 'http://second.test/'],
      headers: new Headers(),
      body: null,
      signal: new AbortController().signal,
      timeouts,
      maxBodyBytes: 0,
      upstreamAttemptMs: 50,
    })
    expect(urls).toEqual(['http://first.test/'])
    expect(result.response?.status).toBe(200)
  })
})
