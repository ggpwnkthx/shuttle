import { describe, expect, test } from 'bun:test'
import {
  TRACEPARENT_HEADER,
  newSpanId,
  newTraceId,
  parseTraceparent,
  traceContextOf,
  traceparentOf,
} from './index'

/**
 * The trace of a request.
 *
 * The gateway writes its own span: the header of the caller is not
 * forwarded as it is, so the upstream always receives a well formed
 * context and the span of the upstream is a child of the span of the
 * gateway.
 */
describe('the trace of a request', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
  const spanId = '00f067aa0ba902b7'

  test('a well formed header is parsed', () => {
    const parsed = parseTraceparent(`00-${traceId}-${spanId}-01`)
    expect(parsed?.traceId).toBe(traceId)
    expect(parsed?.spanId).toBe(spanId)
    expect(parsed?.flags).toBe('01')
    expect(parsed?.sampled).toBe(true)
  })

  test('a header that is not well formed is refused', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('not-a-trace')).toBeNull()
    expect(parseTraceparent(`00-${traceId}-${spanId}`)).toBeNull()
    expect(parseTraceparent(`00-${traceId}-${spanId}-01-02`)).toBeNull()
    // An id of zeroes is not an id.
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${spanId}-01`)).toBeNull()
    expect(parseTraceparent(`00-${traceId}-${'0'.repeat(16)}-01`)).toBeNull()
    // The version `ff` is not a version.
    expect(parseTraceparent(`ff-${traceId}-${spanId}-01`)).toBeNull()
  })

  test('the context of the caller is kept and the span of the gateway is new', () => {
    const context = traceContextOf(`00-${traceId}-${spanId}-01`)
    expect(context.traceId).toBe(traceId)
    // The span of the gateway is not the span of the caller: the span of
    // the upstream is a child of it.
    expect(context.spanId).not.toBe(spanId)
    expect(context.spanId).toHaveLength(16)
  })

  test('a request without a well formed header gets a new trace', () => {
    const context = traceContextOf('not-a-trace')
    expect(context.traceId).toHaveLength(32)
    expect(context.traceId).not.toBe(traceId)
    expect(context.spanId).toHaveLength(16)
  })

  test('the header the gateway writes is well formed', () => {
    const context = traceContextOf(`00-${traceId}-${spanId}-01`)
    const value = traceparentOf(context)
    expect(value).toBe(`00-${traceId}-${context.spanId}-01`)
    expect(parseTraceparent(value)).not.toBeNull()
    expect(TRACEPARENT_HEADER).toBe('traceparent')
  })

  test('the flags of the caller are kept', () => {
    const context = traceContextOf(`00-${traceId}-${spanId}-00`)
    expect(context.flags).toBe('00')
    expect(context.sampled).toBe(false)
  })

  test('the ids are never all zeroes', () => {
    expect(newTraceId()).not.toMatch(/^0+$/)
    expect(newSpanId()).not.toMatch(/^0+$/)
    // A random source that always returns zero still yields a usable id.
    expect(newSpanId(() => 0)).not.toMatch(/^0+$/)
    expect(newTraceId(() => 0)).not.toMatch(/^0+$/)
  })
})
