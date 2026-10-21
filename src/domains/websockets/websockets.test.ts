import { describe, expect, test } from 'bun:test'
import {
  ReservationManager,
  WebSocketService,
  offeredProtocols,
  type ClientEventHandlers,
  type ClientLeg,
  type ClientUpgradePort,
  type ClientUpgradeResult,
  type UpstreamHandshakeOutcome,
  type UpstreamHandshakePort,
  type UpstreamSocket,
  type WebSocketUpgradeContext,
} from './index'

/** A leg of the caller that records what it received. */
function fakeLeg(): ClientLeg & { sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = []
  return {
    sent,
    send(message) {
      sent.push(message)
      return 1
    },
    close() {},
    terminate() {},
    get bufferedAmount() {
      return 0
    },
    ping() {},
  }
}

/** The upstream leg of a test. */
function fakeUpstream(): UpstreamSocket & { sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = []
  const listeners = new Map<string, (...args: never[]) => void>()
  return {
    sent,
    send(message) {
      sent.push(message)
    },
    close() {},
    terminate() {},
    get bufferedAmount() {
      return 0
    },
    on(event, listener) {
      listeners.set(event, listener as (...args: never[]) => void)
    },
    ping() {},
  }
}

/** A request of an upgrade. */
function newRequest(): Request {
  return new Request('https://api.example.com/ws/123')
}

/** The context of an upgrade. */
function context(overrides: Partial<WebSocketUpgradeContext> = {}): WebSocketUpgradeContext {
  return {
    routeId: 'workspace-api',
    upstream: 'http://upstream.test',
    path: '/ws/123',
    search: '',
    method: 'GET',
    headers: new Headers(),
    upstreamHeaders: {},
    requestId: 'req-1',
    cookies: [],
    carriesSessionCookie: false,
    host: 'api.example.com',
    externalProto: 'https',
    allowedOrigins: [],
    ...overrides,
  }
}

describe('the reservations of the connections', () => {
  test('the handshakes that are in flight count as connections', () => {
    const reservations = new ReservationManager({ maxConnections: 2 })
    expect(reservations.reserve()).toBe(true)
    expect(reservations.reserve()).toBe(true)
    expect(reservations.reserve()).toBe(false)
    expect(reservations.connectionCount).toBe(2)
  })

  test('a connection that is open occupies its slot', () => {
    const reservations = new ReservationManager({ maxConnections: 1 })
    reservations.reserve()
    reservations.promote()
    expect(reservations.openCount).toBe(1)
    expect(reservations.reserve()).toBe(false)
    reservations.release()
    expect(reservations.reserve()).toBe(true)
  })

  test('a limit of zero means no limit', () => {
    const reservations = new ReservationManager({ maxConnections: 0 })
    for (let index = 0; index < 1000; index++) {
      expect(reservations.reserve()).toBe(true)
    }
  })
})

describe('the subprotocols of the caller', () => {
  test('the offer of the caller is read', () => {
    expect(offeredProtocols('chat, other')).toEqual(['chat', 'other'])
    expect(offeredProtocols(undefined)).toEqual([])
    expect(offeredProtocols('')).toEqual([])
  })
})

describe('the handshake of a websocket', () => {
  /** The service of the tests, with a fake upstream. */
  function service(options: { outcome?: UpstreamHandshakeOutcome; maxConnections?: number } = {}): {
    service: WebSocketService
    upstream: { connected: number; socket: UpstreamSocket }
    upgrade: { called: number; result: ClientUpgradeResult | null }
  } {
    const upstream = {
      connected: 0,
      socket: fakeUpstream(),
    }
    const handshake: UpstreamHandshakePort = {
      async connect() {
        upstream.connected += 1
        return (
          options.outcome ?? {
            kind: 'accepted',
            protocol: 'chat',
            headers: new Headers(),
            socket: upstream.socket,
          }
        )
      },
    }
    const upgrade = {
      called: 0,
      result: {
        leg: fakeLeg(),
        events: {} as ClientEventHandlers,
      } as ClientUpgradeResult | null,
    }
    const port: ClientUpgradePort = {
      async upgrade() {
        upgrade.called += 1
        return upgrade.result
      },
    }
    void port
    const instance = new WebSocketService({
      upstream: handshake,
      reservations: new ReservationManager({ maxConnections: options.maxConnections ?? 10 }),
      settings: {
        maxConnections: options.maxConnections ?? 10,
        maxBufferedBytes: 1024,
        maxBufferedMessages: 10,
        backpressureLimitBytes: 1024,
        pingIntervalMs: 0,
        pongTimeoutMs: 1000,
        handshakeTimeoutMs: 1000,
      },
      logger: {
        level: 'silent',
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      observer: {
        requestStarted: () => undefined,
        requestFinished: () => undefined,
        recordRequest: () => undefined,
        recordAuthFailure: () => undefined,
        recordAccessUnavailable: () => undefined,
        recordUpstream: () => undefined,
        recordWebsocket: () => undefined,
        recordWebsocketRefusal: () => undefined,
        recordConfigReload: () => undefined,
        recordRateLimit: () => undefined,
        recordCrossSiteRefusal: () => undefined,
        recordSharedStateError: () => undefined,
        render: async () => '',
        contentType: 'text/plain',
      },
    })
    return { service: instance, upstream, upgrade }
  }

  test('a handshake with the cookie of the session needs an allowed origin', async () => {
    const { service: websockets, upstream } = service()
    const outcome = await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context({
        carriesSessionCookie: true,
        headers: new Headers({ origin: 'https://evil.example' }),
      }),
      { upgrade: async () => null }
    )
    expect(outcome).toEqual({
      kind: 'refused',
      status: 403,
      code: 'cross_site_request',
      message: 'the origin "https://evil.example" is not allowed',
    })
    // The upstream was not contacted: the check happens first.
    expect(upstream.connected).toBe(0)
  })

  test('a handshake without an origin is refused when the cookie is there', async () => {
    const { service: websockets, upstream } = service()
    const outcome = await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context({ carriesSessionCookie: true }),
      { upgrade: async () => null }
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(403)
    expect(upstream.connected).toBe(0)
  })

  test('a handshake of an api client does not need an origin', async () => {
    const { service: websockets, upstream } = service()
    const outcome = await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context({ carriesSessionCookie: false }),
      { upgrade: async () => ({ leg: fakeLeg(), events: {} }) }
    )
    expect(outcome.kind).toBe('upgraded')
    expect(upstream.connected).toBe(1)
  })

  test('a refusal of the upstream is a bad gateway', async () => {
    const { service: websockets } = service({
      outcome: { kind: 'refused', status: 403, headers: new Headers(), body: 'denied' },
    })
    const outcome = await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context(),
      { upgrade: async () => null }
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(502)
  })

  test('an upstream that does not answer is a bad gateway', async () => {
    const { service: websockets } = service({
      outcome: { kind: 'failed', reason: 'timeout', message: 'no answer' },
    })
    const outcome = await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context(),
      { upgrade: async () => null }
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(502)
  })

  test('an upgrade that the runtime refuses is a bad request', async () => {
    const { service: websockets } = service()
    const outcome = await websockets.handle(newRequest(), context(), { upgrade: async () => null })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.status).toBe(400)
  })

  test('the limit of the connections is refused with a service unavailable', async () => {
    // The first handshake stays in flight: it occupies a slot.
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const handshake: UpstreamHandshakePort = {
      async connect() {
        await pending
        return {
          kind: 'accepted',
          protocol: '',
          headers: new Headers(),
          socket: fakeUpstream(),
        }
      },
    }
    const websockets = new WebSocketService({
      upstream: handshake,
      reservations: new ReservationManager({ maxConnections: 1 }),
      settings: {
        maxConnections: 1,
        maxBufferedBytes: 1024,
        maxBufferedMessages: 10,
        backpressureLimitBytes: 1024,
        pingIntervalMs: 0,
        pongTimeoutMs: 1000,
        handshakeTimeoutMs: 1000,
      },
      logger: {
        level: 'silent',
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      observer: {
        requestStarted: () => undefined,
        requestFinished: () => undefined,
        recordRequest: () => undefined,
        recordAuthFailure: () => undefined,
        recordAccessUnavailable: () => undefined,
        recordUpstream: () => undefined,
        recordWebsocket: () => undefined,
        recordWebsocketRefusal: () => undefined,
        recordConfigReload: () => undefined,
        recordRateLimit: () => undefined,
        recordCrossSiteRefusal: () => undefined,
        recordSharedStateError: () => undefined,
        render: async () => '',
        contentType: 'text/plain',
      },
    })
    const first = websockets.handle(new Request('https://api.example.com/ws/123'), context(), {
      upgrade: async () => ({ leg: fakeLeg(), events: {} }),
    })
    await Bun.sleep(20)
    const second = await websockets.handle(newRequest(), context(), { upgrade: async () => null })
    expect(second.kind).toBe('refused')
    if (second.kind !== 'refused') return
    expect(second.status).toBe(503)
    expect(second.code).toBe('too_many_connections')
    release?.()
    await first
  })

  test('the handshake of the upstream carries the headers of the application', async () => {
    let headers: Record<string, string> = {}
    const upstream = {
      connected: 0,
      socket: fakeUpstream(),
    }
    const handshake: UpstreamHandshakePort = {
      async connect(request) {
        headers = request.headers
        upstream.connected += 1
        return {
          kind: 'accepted',
          protocol: '',
          headers: new Headers(),
          socket: upstream.socket,
        }
      },
    }
    const websockets = new WebSocketService({
      upstream: handshake,
      reservations: new ReservationManager({ maxConnections: 10 }),
      settings: {
        maxConnections: 10,
        maxBufferedBytes: 1024,
        maxBufferedMessages: 10,
        backpressureLimitBytes: 1024,
        pingIntervalMs: 0,
        pongTimeoutMs: 1000,
        handshakeTimeoutMs: 1000,
      },
      logger: {
        level: 'silent',
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      observer: {
        requestStarted: () => undefined,
        requestFinished: () => undefined,
        recordRequest: () => undefined,
        recordAuthFailure: () => undefined,
        recordAccessUnavailable: () => undefined,
        recordUpstream: () => undefined,
        recordWebsocket: () => undefined,
        recordWebsocketRefusal: () => undefined,
        recordConfigReload: () => undefined,
        recordRateLimit: () => undefined,
        recordCrossSiteRefusal: () => undefined,
        recordSharedStateError: () => undefined,
        render: async () => '',
        contentType: 'text/plain',
      },
    })
    await websockets.handle(
      new Request('https://api.example.com/ws/123'),
      context({
        // The header policy of the application: the cookies of the gateway
        // are already gone and the identity is already written.
        upstreamHeaders: {
          'x-shuttle-user': 'user-1',
          'x-shuttle-roles': 'admin',
          'x-shuttle-signature': 'v3=abc',
        },
        headers: new Headers({ 'sec-websocket-key': 'the-key', cookie: 'app=1' }),
      }),
      { upgrade: async () => ({ leg: fakeLeg(), events: {} }) }
    )
    expect(headers['x-shuttle-user']).toBe('user-1')
    expect(headers['x-shuttle-roles']).toBe('admin')
    expect(headers['x-shuttle-signature']).toBe('v3=abc')
    // The headers of the caller are not forwarded: the domain never builds
    // the headers of the handshake itself.
    expect(headers.cookie).toBeUndefined()
    expect(headers['sec-websocket-key']).toBeUndefined()
  })
})
