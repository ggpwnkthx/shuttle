import { proxy } from 'hono/proxy'
import type { Timeouts } from '../config/schema'

class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds the ${limit} byte limit`)
    this.name = 'PayloadTooLargeError'
  }
}

export type ForwardErrorKind = 'timeout' | 'too_large' | 'aborted' | 'network'

export interface ForwardError {
  kind: ForwardErrorKind
  message: string
}

export interface ForwardResult {
  response?: Response
  error?: ForwardError
  durationMs: number
  /** The number of bytes of the request body that reached the upstream. */
  bytesIn: number
  /** The number of bytes of the response body that were streamed back. */
  bytesOut: number
}

export interface ForwardOptions {
  request: Request
  url: string
  headers: Headers
  timeouts: Timeouts
  maxBodyBytes: number
  /** Signal aborted when the client goes away. */
  clientSignal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * The phases of an upstream exchange, in the order they happen.
 *
 * - `upload`   the request body reaches the upstream
 * - `connect`  the upstream has the request and starts answering
 * - `headers`  the response arrived and its body starts
 * - `body`     the response body is streamed
 */
type Phase = 'upload' | 'connect' | 'headers' | 'body'

const PHASE_MESSAGES: Record<Phase, string> = {
  upload: 'the request body could not be sent to the upstream in time',
  connect: 'the upstream did not start answering in time',
  headers: 'the upstream did not send a response body in time',
  body: 'the response body timed out',
}

type Timer = ReturnType<typeof setTimeout>

/**
 * Wraps a body stream so that it fails once more than `limit` bytes are read.
 *
 * `onEnd` is called when the stream ends, which is the moment the upstream
 * has the whole request. The bytes that passed through are counted, so the
 * metrics report what was really transferred and not what the client
 * announced in its `content-length`.
 */
function limitBodyStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onEnd?: () => void,
  counter?: ByteCounter,
  onChunk?: () => void
): ReadableStream<Uint8Array> {
  let seen = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (counter) counter.value += chunk.byteLength
        if (seen > limit) {
          controller.error(new PayloadTooLargeError(limit))
          return
        }
        onChunk?.()
        controller.enqueue(chunk)
      },
      flush() {
        onEnd?.()
      },
    })
  )
}

/** A counter of bytes. */
interface ByteCounter {
  value: number
}

/** Wraps a body stream to observe the moment it ends. */
function trackBodyStream(
  stream: ReadableStream<Uint8Array>,
  onEnd: () => void,
  counter?: ByteCounter,
  onChunk?: () => void
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (counter) counter.value += chunk.byteLength
        onChunk?.()
        controller.enqueue(chunk)
      },
      flush() {
        onEnd()
      },
    })
  )
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

/**
 * Forwards a request upstream using Hono's proxy helper.
 *
 * The request body is streamed (never buffered), redirects are not followed
 * automatically and every phase of the exchange has its own budget:
 *
 * | Phase | Budget | Ends when |
 * | --- | --- | --- |
 * | upload | `bodyMs` | the request body reached the upstream |
 * | connect | `connectMs` | the upstream started answering |
 * | headers | `headersMs` | the body of the response started |
 * | body | `bodyMs` | the response body was streamed completely |
 *
 * The connect budget is the important one: an upstream that does not answer
 * at all is given up on quickly instead of holding the request until the
 * header budget is over.
 */
export async function forwardRequest(options: ForwardOptions): Promise<ForwardResult> {
  const started = Date.now()
  const { request, url, headers, timeouts, maxBodyBytes } = options

  const contentLength = request.headers.get('content-length')
  if (maxBodyBytes > 0 && contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return {
        error: { kind: 'too_large', message: `request body exceeds the ${maxBodyBytes} byte limit` },
        durationMs: Date.now() - started,
        bytesIn: 0,
        bytesOut: 0,
      }
    }
  }

  /** The bytes that really went through, counted while the bodies stream. */
  const requestBytes: ByteCounter = { value: 0 }
  const responseBytes: ByteCounter = { value: 0 }

  const controller = new AbortController()
  /** The phase whose budget ran out, if the request was aborted by us. */
  let timedOutPhase: Phase | null = null
  /** Set once the upstream answered, so no new timer is armed anymore. */
  let answered = false

  const arm = (ms: number, phase: Phase): Timer => {
    const timer = setTimeout(() => {
      timedOutPhase = phase
      controller.abort(new Error(PHASE_MESSAGES[phase]))
    }, ms)
    timer.unref?.()
    return timer
  }

  const disarm = (timer: Timer | undefined): void => {
    if (timer) clearTimeout(timer)
  }

  let uploadTimer: Timer | undefined = arm(timeouts.bodyMs, 'upload')
  let connectTimer: Timer | undefined
  let headerTimer: Timer | undefined
  let bodyTimer: Timer | undefined

  /**
   * Resolves when the request has been sent completely. The connect budget
   * starts there: a request that is still uploading is not a request that
   * waits for an answer.
   */
  let markSent = (): void => {}
  const sent = new Promise<void>((resolve) => {
    markSent = resolve
  })
  void sent.then(() => {
    if (answered) return
    connectTimer = arm(timeouts.connectMs, 'connect')
  })

  const signals: AbortSignal[] = [controller.signal]
  if (options.clientSignal) signals.push(options.clientSignal)
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!

  let body: ReadableStream<Uint8Array> | null | undefined
  if (request.body) {
    body =
      maxBodyBytes > 0
        ? limitBodyStream(request.body, maxBodyBytes, markSent, requestBytes)
        : trackBodyStream(request.body, markSent, requestBytes)
  } else {
    // A request without a body is sent right away.
    markSent()
  }

  try {
    const response = await proxy(url, {
      method: request.method,
      headers,
      body: body ?? undefined,
      duplex: body ? 'half' : undefined,
      redirect: 'manual',
      signal,
      customFetch: options.fetchImpl,
    } as Parameters<typeof proxy>[1])

    // The upstream answered: the upload and the connect phase are over.
    answered = true
    disarm(uploadTimer)
    disarm(connectTimer)
    uploadTimer = undefined
    connectTimer = undefined

    if (!response.body) {
      return { response, durationMs: Date.now() - started, bytesIn: requestBytes.value, bytesOut: 0 }
    }

    // The response arrived, its body has to start.
    headerTimer = arm(timeouts.headersMs, 'headers')

    let first = true
    const streamed = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (first) {
            first = false
            disarm(headerTimer)
            headerTimer = undefined
            bodyTimer = arm(timeouts.bodyMs, 'body')
          }
          responseBytes.value += chunk.byteLength
          controller.enqueue(chunk)
        },
        flush() {
          disarm(headerTimer)
          disarm(bodyTimer)
          headerTimer = undefined
          bodyTimer = undefined
        },
      })
    )
    return {
      response: new Response(streamed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      durationMs: Date.now() - started,
      bytesIn: requestBytes.value,
      bytesOut: responseBytes.value,
    }
  } catch (error) {
    answered = true
    disarm(uploadTimer)
    disarm(connectTimer)
    disarm(headerTimer)
    disarm(bodyTimer)
    uploadTimer = undefined
    connectTimer = undefined
    headerTimer = undefined
    bodyTimer = undefined
    if (error instanceof PayloadTooLargeError) {
      return {
        error: { kind: 'too_large', message: error.message },
        durationMs: Date.now() - started,
        bytesIn: requestBytes.value,
        bytesOut: responseBytes.value,
      }
    }
    if (timedOutPhase) {
      return {
        error: { kind: 'timeout', message: PHASE_MESSAGES[timedOutPhase] },
        durationMs: Date.now() - started,
        bytesIn: requestBytes.value,
        bytesOut: responseBytes.value,
      }
    }
    if (options.clientSignal?.aborted || isAbortError(error)) {
      return {
        error: { kind: 'aborted', message: 'client aborted the request' },
        durationMs: Date.now() - started,
        bytesIn: requestBytes.value,
        bytesOut: responseBytes.value,
      }
    }
    return {
      error: { kind: 'network', message: error instanceof Error ? error.message : String(error) },
      durationMs: Date.now() - started,
      bytesIn: requestBytes.value,
      bytesOut: responseBytes.value,
    }
  }
}
