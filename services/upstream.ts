#!/usr/bin/env bun
/**
 * A sample upstream application.
 *
 * It echoes the request it received, streams server sent events and accepts
 * websocket connections. It is used by the compose stack, by the development
 * runner and by the tests.
 */
import { createHash } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { Hono, type Context } from 'hono'

export interface UpstreamOptions {
  name: string
  port?: number
  hostname?: string
}

/** Headers that are echoed back so that tests can assert on header handling. */
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
]

/**
 * Stable, short hash used to fingerprint a header without revealing it.
 *
 * The upstream echoes the hash instead of the value, so a test can assert
 * that a credential was forwarded without the credential ending up in the
 * response.
 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** The request, as the upstream received it. */
function describeRequest(c: Context) {
  const headers: Record<string, string> = {}
  for (const name of ECHOED_HEADERS) {
    const value = c.req.header(name)
    if (value !== undefined) headers[name] = value
  }
  const authorization = c.req.header('authorization')
  return {
    headers,
    authorizationPresent: Boolean(authorization),
    authorizationFingerprint: authorization ? fingerprint(authorization) : null,
  }
}

export function createUpstream(options: UpstreamOptions) {
  const app = new Hono()

  /** Sends the caller to another location. */
  const redirectHandler = (c: Context) => {
    const target = c.req.query('to') ?? '/'
    return c.redirect(target, 302)
  }

  app.get('/healthz', (c) => c.json({ status: 'ok', service: options.name }))

  app.get('/', async (c) => {
    const described = describeRequest(c)
    return c.json({
      service: options.name,
      method: c.req.method,
      path: c.req.path,
      query: { ...c.req.query() },
      ...described,
    })
  })

  app.post('/echo', async (c) => {
    const body = await c.req.text()
    return c.json({
      service: options.name,
      length: body.length,
      body,
    })
  })

  app.get('/sse', (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let count = 0
        const timer = setInterval(() => {
          count += 1
          const payload = `event: message\ndata: ${JSON.stringify({
            service: options.name,
            count,
            at: Date.now(),
          })}\n\n`
          controller.enqueue(new TextEncoder().encode(payload))
          if (count >= 5) {
            clearInterval(timer)
            controller.close()
          }
        }, 120)
        c.req.raw.signal.addEventListener('abort', () => {
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
        connection: 'keep-alive',
      },
    })
  })

  app.get('/slow', async (c) => {
    const delay = Number(c.req.query('ms') ?? '1000')
    await Bun.sleep(Math.min(delay, 30_000))
    return c.json({ service: options.name, delayedMs: delay })
  })

  app.get('/status/:code', (c) => {
    const code = Number(c.req.param('code') ?? '200')
    return c.json({ service: options.name, status: code }, code as never)
  })

  app.get('/redirect', redirectHandler)

  app.get('/set-cookie', (c) => {
    c.header('set-cookie', 'upstream_session=abc123; Path=/; HttpOnly')
    return c.json({ service: options.name, cookie: 'set' })
  })

  // Any other path is echoed back so that the gateway can be tested with
  // arbitrary request paths.
  app.all('*', async (c) => {
    // The redirect is also served under a prefix: the gateway forwards the
    // whole path of the request, so an application that is mounted under
    // `/ws/{id}/` answers on `/ws/{id}/redirect`.
    if (c.req.path.endsWith('/redirect')) return redirectHandler(c)
    const described = describeRequest(c)
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text()
    return c.json({
      service: options.name,
      method: c.req.method,
      path: c.req.path,
      query: { ...c.req.query() },
      ...described,
      bodyLength: body.length,
      body: body.length > 0 && body.length < 4096 ? body : undefined,
    })
  })

  return app
}

export interface StartedUpstream {
  url: string
  stop: () => Promise<void>
}

export async function startUpstream(options: UpstreamOptions): Promise<StartedUpstream> {
  const app = createUpstream(options)
  const server = Bun.serve<{ service: string }>({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch: (request, server) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/ws')) {
        // The upstream selects the first subprotocol the client offered, so
        // the gateway can be tested with a handshake that negotiates one.
        const offered = (request.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        const upgraded = server.upgrade(request, {
          data: { service: options.name },
          headers: offered.length > 0 ? { 'sec-websocket-protocol': offered[0]! } : undefined,
        })
        if (upgraded) return new Response(null)
        return new Response('websocket upgrade failed', { status: 400 })
      }
      return app.fetch(request)
    },
    websocket: {
      open(ws: ServerWebSocket<{ service: string }>) {
        ws.send(JSON.stringify({ service: options.name, event: 'open' }))
      },
      message(ws: ServerWebSocket<{ service: string }>, message: string | Uint8Array) {
        ws.send(JSON.stringify({ service: options.name, event: 'echo', message }))
      },
      close() {
        /* nothing to clean up */
      },
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const name = process.env.UPSTREAM_NAME ?? 'upstream'
  const upstream = await startUpstream({
    name,
    port,
    hostname: process.env.HOST ?? '0.0.0.0',
  })
  console.log(
    JSON.stringify({ level: 'info', msg: 'shuttle sample upstream started', name, port })
  )

  const shutdown = (): void => {
    void upstream.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
