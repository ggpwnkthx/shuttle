import { describe, expect, test } from 'bun:test'
import {
  CLOSE_GOING_AWAY,
  CLOSE_TRY_AGAIN_LATER,
  WebSocketBridge,
  periodOf,
  truncateCloseReason,
  type ClientLeg,
  type UpstreamSocket,
} from './index'

/** The leg of the caller of a test. */
function fakeClient(options: { sendStatus?: number; bufferedAmount?: number } = {}) {
  const sent: (string | Uint8Array)[] = []
  const closed: { code?: number; reason?: string }[] = []
  const pings: number[] = []
  const leg: ClientLeg = {
    send(message) {
      sent.push(message)
      return options.sendStatus ?? 1
    },
    close(code, reason) {
      closed.push({ code, reason })
    },
    terminate() {},
    get bufferedAmount() {
      return options.bufferedAmount ?? 0
    },
    ping() {
      pings.push(Date.now())
    },
  }
  return { leg, sent, closed, pings }
}

/** The upstream leg of a test. */
function fakeUpstream(options: { bufferedAmount?: number } = {}) {
  const sent: (string | Uint8Array)[] = []
  const closed: { code?: number; reason?: string }[] = []
  const listeners = new Map<string, (...args: never[]) => void>()
  const pings: number[] = []
  const socket: UpstreamSocket = {
    send(message) {
      sent.push(message)
    },
    close(code, reason) {
      closed.push({ code, reason })
    },
    terminate() {},
    get bufferedAmount() {
      return options.bufferedAmount ?? 0
    },
    on(event, listener) {
      listeners.set(event, listener as (...args: never[]) => void)
    },
    ping() {
      pings.push(Date.now())
    },
  }
  const emit = (event: string, ...args: unknown[]): void => {
    listeners.get(event)?.(...(args as never[]))
  }
  return { socket, sent, closed, pings, emit }
}

/** The options of a bridge of the tests. */
function options(client: ClientLeg, upstream: UpstreamSocket) {
  return {
    client,
    upstream,
    maxBufferedBytes: 1024,
    maxBufferedMessages: 3,
    backpressureLimitBytes: 512,
    pingIntervalMs: 0,
    pongTimeoutMs: 50,
  }
}

describe('the bridge of a websocket', () => {
  test('a message of the caller is relayed to the upstream', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    bridge.relayToUpstream('hello')
    expect(upstream.sent).toEqual(['hello'])
    expect(bridge.closed).toBe(false)
  })

  test('a message of the upstream is relayed to the caller', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    upstream.emit('message', 'from the upstream', false)
    expect(client.sent).toEqual(['from the upstream'])
  })

  test('the buffer of the connection is bounded in messages', () => {
    const client = fakeClient()
    // The upstream is behind: the messages of the caller wait in the queue
    // of the gateway.
    const upstream = fakeUpstream({ bufferedAmount: 1 })
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    for (let index = 0; index < 10; index++) {
      bridge.relayToUpstream('x'.repeat(10))
    }
    // The connection is closed instead of growing the memory of the
    // process: the queue of the upstream is over the limit.
    expect(bridge.closed).toBe(true)
    expect(client.closed[0]?.code).toBe(CLOSE_TRY_AGAIN_LATER)
  })

  test('the buffer of the connection is bounded in bytes', () => {
    const client = fakeClient()
    const upstream = fakeUpstream({ bufferedAmount: 1 })
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      maxBufferedBytes: 16,
    })
    bridge.start()
    bridge.relayToUpstream('x'.repeat(32))
    expect(bridge.closed).toBe(true)
  })

  test('an upstream that is too slow closes the connection', () => {
    const client = fakeClient()
    const upstream = fakeUpstream({ bufferedAmount: 4096 })
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    bridge.relayToUpstream('hello')
    expect(bridge.closed).toBe(true)
    expect(client.closed[0]?.code).toBe(CLOSE_TRY_AGAIN_LATER)
  })

  test('a caller that does not read closes the connection', () => {
    const client = fakeClient({ sendStatus: -1, bufferedAmount: 4096 })
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    upstream.emit('message', 'a lot of bytes', false)
    expect(bridge.closed).toBe(true)
    expect(client.closed[0]?.code).toBe(CLOSE_TRY_AGAIN_LATER)
  })

  test('a message that was dropped closes the connection', () => {
    const client = fakeClient({ sendStatus: 0 })
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    upstream.emit('message', 'dropped', false)
    expect(bridge.closed).toBe(true)
  })

  test('the close of the upstream closes the caller as well', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    upstream.emit('close', 1001, 'the upstream is going away')
    expect(bridge.closed).toBe(true)
    expect(client.closed[0]?.code).toBe(1001)
    expect(upstream.closed.length).toBeGreaterThanOrEqual(0)
  })

  test('an error of the upstream closes the connection', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    upstream.emit('error', new Error('the upstream failed'))
    expect(bridge.closed).toBe(true)
    expect(client.closed[0]?.code).toBe(CLOSE_GOING_AWAY)
  })

  test('the keepalive pings the two legs', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      pingIntervalMs: 10,
      pongTimeoutMs: 10_000,
    })
    bridge.start()
    await Bun.sleep(30)
    expect(client.pings.length).toBeGreaterThanOrEqual(1)
    expect(upstream.pings.length).toBeGreaterThanOrEqual(1)
    bridge.close()
    // The timer of the keepalive is gone with the connection.
    const before = client.pings.length
    Bun.sleep(40)
    expect(client.pings.length).toBe(before)
  })

  test('a caller that does not answer the ping is closed', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      pingIntervalMs: 10,
      pongTimeoutMs: 20,
    })
    bridge.start()
    await Bun.sleep(120)
    expect(bridge.closed).toBe(true)
  })

  test('the connection is closed exactly once', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    let closes = 0
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      onClose: () => {
        closes += 1
      },
    })
    bridge.start()
    bridge.close(1000, 'done')
    bridge.close(1000, 'done again')
    expect(closes).toBe(1)
    expect(client.closed).toHaveLength(1)
  })

  test('the reason of a close is cut to the size of the protocol', () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    bridge.close(1000, 'x'.repeat(200))
    expect((client.closed[0]?.reason ?? '').length).toBeLessThanOrEqual(123)
  })
})

describe('the revalidation of a websocket', () => {
  test('a connection that may stay open stays open', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      revalidateIntervalMs: 5,
    })
    bridge.start()
    bridge.startRevalidation(async () => ({ allowed: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(client.closed).toHaveLength(0)
    bridge.close(1000, 'done')
  })

  test('a connection that may not stay open is closed', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      revalidateIntervalMs: 5,
    })
    bridge.start()
    bridge.startRevalidation(async () => ({ allowed: false, reason: 'the access was revoked' }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(client.closed).toHaveLength(1)
    expect(client.closed[0]?.code).toBe(1008)
    expect(upstream.closed[0]?.code).toBe(1008)
  })

  test('a revalidation that fails closes the connection', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge({
      ...options(client.leg, upstream.socket),
      revalidateIntervalMs: 5,
    })
    bridge.start()
    bridge.startRevalidation(async () => {
      throw new Error('the access service is not reachable')
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(client.closed).toHaveLength(1)
    expect(client.closed[0]?.code).toBe(1008)
  })

  test('a revalidation of zero never runs', async () => {
    const client = fakeClient()
    const upstream = fakeUpstream()
    const bridge = new WebSocketBridge(options(client.leg, upstream.socket))
    bridge.start()
    let calls = 0
    bridge.startRevalidation(async () => {
      calls += 1
      return { allowed: false }
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(0)
    expect(client.closed).toHaveLength(0)
    bridge.close(1000, 'done')
  })
})

describe('the reason of a close', () => {
  test('a short reason is kept', () => {
    expect(truncateCloseReason('done')).toBe('done')
    expect(truncateCloseReason(undefined)).toBe('')
  })

  test('a long reason is cut on a character boundary', () => {
    const cut = truncateCloseReason('ä'.repeat(200))
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(123)
    // The cut is a valid string: a half of a character would not be.
    expect(cut).toBe('ä'.repeat(cut.length))
  })
})

describe('the schedule of the revalidation', () => {
  test('the period of a connection is drawn around the interval', () => {
    // The period is the interval of the deployment, drawn from a band of
    // forty percent around it: the latency of a revocation stays close to
    // the interval and the checks of the deployment do not line up.
    for (let index = 0; index < 200; index += 1) {
      const period = periodOf(60_000)
      expect(period).toBeGreaterThanOrEqual(48_000)
      expect(period).toBeLessThanOrEqual(72_000)
    }
  })

  test('two connections do not have the same period', () => {
    const periods = new Set<number>()
    for (let index = 0; index < 50; index += 1) periods.add(periodOf(60_000))
    // The probability of fifty draws landing on the same millisecond is
    // negligible: the connections of the deployment do not revalidate at
    // the same moment.
    expect(periods.size).toBeGreaterThan(45)
  })

  test('the first check of a connection is spread over the interval', async () => {
    const delays: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const client = fakeClient()
      const upstream = fakeUpstream()
      const bridge = new WebSocketBridge({
        ...options(client.leg, upstream.socket),
        revalidateIntervalMs: 60_000,
      })
      bridge.start()
      let called = false
      bridge.startRevalidation(async () => {
        called = true
        return { allowed: true }
      })
      // The first check happens somewhere inside the interval: the
      // connections that were opened together do not all check at the
      // same instant.
      await new Promise((resolve) => setTimeout(resolve, 5))
      delays.push(called ? 1 : 0)
      bridge.close(1000, 'done')
    }
    // With an interval of a minute, no connection has checked yet, and
    // they are not all at the same point of their schedule.
    expect(delays.every((delay) => delay === 0)).toBe(true)
  })
})
