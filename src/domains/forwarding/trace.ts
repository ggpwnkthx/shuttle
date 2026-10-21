/**
 * The trace of a request.
 *
 * The gateway is in the middle of a call: the caller sends a request and
 * the upstream answers it. The trace context is what ties the two halves
 * together, and it is the standard one of the W3C: a `traceparent` header
 * that carries the id of the trace, the id of the span of the hop and the
 * flags of the trace.
 *
 * The gateway writes its **own** span in the header it sends to the
 * upstream: the span of the upstream is a child of the span of the
 * gateway, and the trace of the caller continues. The id of the trace is
 * the one of the caller when it is well formed, and a new one otherwise.
 *
 * The header of the caller is never forwarded as it is: a malformed
 * `traceparent` would confuse the collector of the upstream, and the
 * gateway writes one that is well formed.
 */

/** The id of a trace: 16 bytes, hexadecimal. */
export type TraceId = string

/** The id of a span: 8 bytes, hexadecimal. */
export type SpanId = string

/** The context of a trace, as the W3C trace context describes it. */
export interface TraceContext {
  /** The id of the trace. */
  traceId: TraceId
  /** The id of the span of the gateway. */
  spanId: SpanId
  /** The flags of the trace. */
  flags: string
  /** True when the trace is sampled. */
  sampled: boolean
}

/** The version of the trace context the gateway writes. */
export const TRACEPARENT_VERSION = '00'

/** The header that carries the trace context. */
export const TRACEPARENT_HEADER = 'traceparent'

/** The shape of a `traceparent`: the version, the trace, the span and the flags. */
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** A trace id or a span id may not be all zeroes. */
const ZERO_ID = /^0+$/

/**
 * Parses a `traceparent` header.
 *
 * A header that is not well formed is refused: the gateway writes a
 * context of its own rather than forwarding a broken one.
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null
  const match = TRACEPARENT_PATTERN.exec(value.trim())
  if (!match) return null
  const version = match[1]!
  const traceId = match[2]!
  const spanId = match[3]!
  const flags = match[4]!
  // A version of `ff` is not a version.
  if (version === 'ff') return null
  if (ZERO_ID.test(traceId) || ZERO_ID.test(spanId)) return null
  return { traceId, spanId, flags, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01 }
}

/**
 * The id of a span, as the W3C trace context describes it.
 *
 * A span id may not be all zeroes, so a random one is generated until it
 * is not.
 */
export function newSpanId(random: () => number = Math.random): SpanId {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = new Uint8Array(8)
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(random() * 256)
    }
    const id = Buffer.from(bytes).toString('hex')
    if (!ZERO_ID.test(id)) return id
  }
  // The probability of eight zeroes in a row is negligible; the fallback
  // is a span id that is not zero.
  return '0000000000000001'
}

/**
 * The id of a trace, as the W3C trace context describes it.
 */
export function newTraceId(random: () => number = Math.random): TraceId {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Math.floor(random() * 256)
  }
  const id = Buffer.from(bytes).toString('hex')
  return ZERO_ID.test(id) ? '00000000000000000000000000000001' : id
}

/**
 * The context of a request.
 *
 * It is the context of the caller when it sent a well formed one, and a
 * new one otherwise. The span is always the one of the gateway: the
 * header the gateway writes names the span of the gateway, so the span of
 * the upstream is a child of it.
 */
export function traceContextOf(incoming: string | null | undefined): TraceContext {
  const parsed = parseTraceparent(incoming)
  return {
    traceId: parsed?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    flags: parsed?.flags ?? '01',
    sampled: parsed?.sampled ?? true,
  }
}

/**
 * The value of the `traceparent` header.
 *
 * It is the id of the trace, the id of the span of the gateway and the
 * flags of the trace.
 */
export function traceparentOf(context: TraceContext): string {
  return `${TRACEPARENT_VERSION}-${context.traceId}-${context.spanId}-${context.flags}`
}
