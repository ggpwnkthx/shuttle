#!/usr/bin/env bun
/**
 * A deterministic upstream application.
 *
 * It is the other side of the wire for the tests of the gateway: it
 * echoes the request it received, it streams server sent events, it accepts
 * and refuses websocket connections and it answers with the statuses the
 * specification talks about.
 *
 * The endpoints that the transport tests need are named after the behavior
 * they prove, so a failing test says what the runtime did.
 */

/** A chunk of an upload, as the upstream saw it. */
export interface UploadChunk {
  bytes: number
  /** The milliseconds between the start of the upload and the chunk. */
  at: number
}

export interface UploadRecord {
  id: string
  chunks: UploadChunk[]
  bytes: number
  complete: boolean
  startedAt: number
}

export interface UpstreamOptions {
  name?: string
  port?: number
  hostname?: string
  /**
   * The TLS of the upstream.
   *
   * With `requireClientCert`, the upstream asks the caller for a
   * certificate and refuses the connections that do not present a valid
   * one: it is the mutual TLS the tests of the gateway need.
   */
  tls?: {
    cert: string
    key: string
    /** The authority that signs the certificate of the caller. */
    ca?: string
    requireClientCert?: boolean
  }
}

export interface StartedUpstream {
  url: string
  port: number
  /** The uploads the upstream received, keyed by their identifier. */
  uploads: Map<string, UploadRecord>
  stop: () => Promise<void>
}

const encoder = new TextEncoder()

/** The headers the upstream echoes, so a test can assert on the header policy. */
const ECHOED_HEADERS = [
  'x-shuttle-user',
  'x-shuttle-email',
  'x-shuttle-roles',
  'x-shuttle-workspace',
  'x-shuttle-signature',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'x-custom-header',
  'content-type',
  'cookie',
  'authorization',
  'traceparent',
]

export function createUpstream(options: UpstreamOptions = {}): StartedUpstream {
  const name = options.name ?? 'upstream'
  const uploads = new Map<string, UploadRecord>()

  const describe = (request: Request): Record<string, unknown> => {
    const headers: Record<string, string> = {}
    for (const header of ECHOED_HEADERS) {
      const value = request.headers.get(header)
      if (value !== null) headers[header] = value
    }
    const url = new URL(request.url)
    return {
      service: name,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      // The target as an upstream reads it: the path and the query string.
      target: `${url.pathname}${url.search}`,
      headers,
    }
  }

  const server = Bun.serve<{ service: string; headers: Record<string, string> }>({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    ...(options.tls
      ? {
          tls: {
            cert: options.tls.cert,
            key: options.tls.key,
            ...(options.tls.ca ? { ca: options.tls.ca } : {}),
            // The upstream asks the caller for a certificate: a caller
            // without a valid one is refused during the handshake.
            ...(options.tls.requireClientCert ? { requestCert: true } : {}),
          },
        }
      : {}),
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok', service: name })
      }

      // The websocket endpoints are answered before the http ones: the
      // upgrade is not a request of the application. Every path accepts a
      // websocket handshake, so a test can mount the application under a
      // prefix.
      if (
        url.pathname === '/ws-refuse' ||
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        if (url.pathname === '/ws-refuse') {
          // The refusal of an upstream is a normal answer: the caller of
          // the gateway deserves to see the status and the body.
          return new Response('the upstream refused the connection', {
            status: 403,
            headers: { 'content-type': 'text/plain' },
          })
        }
        const offered = (request.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        const described = describe(request)
        const upgraded = server.upgrade(request, {
          // The headers of the handshake are kept, so a test can assert on
          // the header policy of the gateway.
          data: { service: name, headers: described.headers as Record<string, string> },
          headers: offered.length > 0 ? { 'sec-websocket-protocol': offered[0]! } : undefined,
        })
        if (upgraded) return new Response(null)
        return new Response('the upgrade was refused', { status: 400 })
      }

      if (url.pathname === '/upload') {
        const id = url.searchParams.get('id') ?? 'default'
        const record: UploadRecord = {
          id,
          chunks: [],
          bytes: 0,
          complete: false,
          startedAt: Date.now(),
        }
        uploads.set(id, record)
        const reader = request.body?.getReader()
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (!value) continue
              record.bytes += value.byteLength
              record.chunks.push({ bytes: value.byteLength, at: Date.now() - record.startedAt })
            }
          } catch {
            // The caller went away: the upload is over.
          }
        }
        record.complete = true
        return Response.json({ id, bytes: record.bytes, chunks: record.chunks })
      }

      if (url.pathname === '/upload-progress') {
        const id = url.searchParams.get('id') ?? 'default'
        const record = uploads.get(id)
        if (!record) return Response.json({ id, chunks: [], bytes: 0, complete: false })
        return Response.json({
          id,
          chunks: record.chunks,
          bytes: record.bytes,
          complete: record.complete,
        })
      }

      if (url.pathname === '/early') {
        // The answer arrives before the upload is over: the upstream does
        // not read the body at all.
        return Response.json({ ...describe(request), early: true })
      }

      if (url.pathname === '/sse') {
        const count = Number(url.searchParams.get('count') ?? '5')
        const delay = Number(url.searchParams.get('delay') ?? '120')
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let sent = 0
            const timer = setInterval(() => {
              sent += 1
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({ service: name, sent })}\n\n`
                )
              )
              if (sent >= count) {
                clearInterval(timer)
                controller.close()
              }
            }, delay)
            request.signal.addEventListener('abort', () => {
              clearInterval(timer)
              try {
                controller.close()
              } catch {
                /* already closed */
              }
            })
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        })
      }

      if (url.pathname === '/delay-headers') {
        const delay = Number(url.searchParams.get('ms') ?? '1000')
        await Bun.sleep(Math.min(delay, 30_000))
        if (request.signal.aborted) return new Response(null, { status: 499 })
        return Response.json({ service: name, delayedHeaders: delay })
      }

      if (url.pathname === '/delay-body') {
        const delay = Number(url.searchParams.get('ms') ?? '1000')
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              try {
                controller.enqueue(encoder.encode('late'))
                controller.close()
              } catch {
                // The caller went away.
              }
            }, delay)
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/plain' } })
      }

      if (url.pathname.startsWith('/status/')) {
        const code = Number(url.pathname.slice('/status/'.length)) || 200
        if (code === 204 || code === 205 || code === 304) {
          return new Response(null, { status: code })
        }
        return Response.json({ service: name, status: code }, { status: code })
      }

      if (url.pathname === '/gzip') {
        // The body is compressed and the gateway has to forward the bytes as
        // they are: it does not decompress the answer of the upstream.
        const compressed = new Uint8Array([
          0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x4b, 0x4c, 0x4a, 0x4e, 0x2c,
          0x2e, 0x56, 0x00, 0xa2, 0x44, 0x00, 0x9d, 0xd3, 0x66, 0x1f, 0x36, 0x06, 0x00, 0x00, 0x00,
        ])
        return new Response(compressed, {
          headers: {
            'content-type': 'text/plain',
            'content-encoding': 'gzip',
            'content-length': String(compressed.byteLength),
          },
        })
      }

      if (url.pathname === '/redirect') {
        const target = url.searchParams.get('to') ?? '/'
        return new Response(null, { status: 302, headers: { location: target } })
      }

      if (url.pathname === '/echo') {
        const body =
          request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text()
        return Response.json({ ...describe(request), bodyLength: body.length, body })
      }

      return Response.json(describe(request))
    },
    websocket: {
      open(ws) {
        const data = ws.data as { service: string; headers?: Record<string, string> }
        ws.send(JSON.stringify({ service: name, event: 'open', headers: data.headers ?? {} }))
      },
      message(ws, message: string | Uint8Array) {
        ws.send(message)
      },
      close() {
        /* nothing to clean up */
      },
    },
  })

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${server.port ?? 0}`,
    port: server.port ?? 0,
    uploads,
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** Starts the upstream and returns its handle. */
export async function startUpstream(options: UpstreamOptions = {}): Promise<StartedUpstream> {
  return createUpstream(options)
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? '3000')
  const name = process.env.UPSTREAM_NAME ?? 'upstream'
  const upstream = await startUpstream({
    name,
    port,
    hostname: process.env.HOST ?? '0.0.0.0',
  })
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'shuttle sample upstream started',
      name,
      port: upstream.port,
    })
  )
  const shutdown = (): void => {
    void upstream.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
