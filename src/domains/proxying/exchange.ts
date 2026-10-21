/**
 * The state of an http exchange.
 *
 * An exchange has two directions that make progress on their own: the upload
 * of the request and the answer of the upstream. Every phase has its own
 * budget:
 *
 * | Phase | Budget | Kind |
 * | --- | --- | --- |
 * | upload | `bodyMs` | idle |
 * | response | `responseMs` | total |
 * | first byte | `firstByteMs` | total |
 * | body | `bodyMs` | idle |
 *
 * The upload is governed by the idle budget only: a client that uploads
 * slowly is not cut off by a total budget. The response budget starts when
 * the upload is over, so a slow upload never eats the budget of the answer.
 *
 * The state machine is the one of the specification:
 *
 * | Event | Action |
 * | --- | --- |
 * | the request is sent without a body | arm the budget of the answer |
 * | the upload makes progress | count the bytes and rearm the idle budget |
 * | the upload is over | clear the upload timer, arm the budget of the answer |
 * | the final headers arrive | clear the budget of the answer, hand the answer over, arm the budget of the first byte when a body is expected |
 * | the first bytes of the body arrive | clear the budget of the first byte, watch the idle progress |
 * | a failure or a disconnect | cancel the work that is left, the commitment decides what the caller sees |
 * | both directions are over | finalize once, clear the timers |
 */

import type { HttpTransport, UpstreamResponse } from './transport'

/** The budgets of the phases of an exchange, in milliseconds. */
export interface ExchangeTimeouts {
  /** The time between the end of the upload and the answer of the upstream. */
  responseMs: number
  /** The time between the answer and the first byte of its body. */
  firstByteMs: number
  /** The time between two chunks, in both directions. */
  bodyMs: number
}

/** The request of an exchange. */
export interface ExchangeRequest {
  /** The method of the request. */
  method: string
  /** The absolute url of the upstream. */
  url: string
  /** The headers of the request, already filtered. */
  headers: Headers
  /** The body of the request, or null when the request has none. */
  body: ReadableStream<Uint8Array> | null
  /** Aborted when the caller goes away. */
  signal: AbortSignal
  /** The budgets of the phases. */
  timeouts: ExchangeTimeouts
  /** The limit of the body of the request, 0 disables it. */
  maxBodyBytes: number
  /**
   * Called exactly once, when the exchange is over.
   *
   * The application uses it to write the log line and the metrics of the
   * request: the exchange is over when the body of the answer is over, not
   * when the middleware returns.
   */
  onFinalize?: (result: ExchangeResult) => void
}

/** Why an exchange failed before the answer of the upstream was committed. */
export type ExchangeFailureKind = 'too_large' | 'timeout' | 'aborted' | 'network' | 'overloaded'

/** A failure of an exchange. */
export interface ExchangeFailure {
  kind: ExchangeFailureKind
  message: string
}

/** The answer of the upstream. */
export interface ExchangeResponse {
  status: number
  statusText: string
  headers: Headers
  /** The body of the answer, or null when the answer has no body. */
  body: ReadableStream<Uint8Array> | null
}

/** How an exchange ended. */
export type ExchangeOutcome = 'complete' | 'aborted'

/** The result of an exchange. */
export interface ExchangeResult {
  /** The answer of the upstream, or null when the exchange failed. */
  response: ExchangeResponse | null
  /** The failure of the exchange, when it failed before the answer. */
  failure: ExchangeFailure | null
  /** The bytes that were read from the request stream. */
  bytesIn: number
  /** The bytes that were handed to the downstream runtime. */
  bytesOut: number
  /** How the exchange ended. */
  outcome: ExchangeOutcome
  /** The status of the answer of the upstream, when there was one. */
  status?: number
}

/** The settings of the exchange service. */
export interface HttpExchangeOptions {
  /** The transport that carries the exchange. */
  transport: HttpTransport
  /**
   * The number of exchanges that may run at the same time.
   *
   * A client that opens a request and never sends its body holds a
   * connection until the idle budget of the upload runs out. The cap is
   * the bound of that: the gateway refuses the exchanges that do not fit
   * instead of running out of resources.
   *
   * A value of zero means "no limit".
   */
  maxConcurrent?: number
  /** Called exactly once, when the exchange is over. */
  onFinalize?: (result: ExchangeResult) => void
}

/** The body of a request that is over the limit. */
class PayloadTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`the request body is over the limit of ${limit} bytes`)
    this.name = 'PayloadTooLargeError'
    this.limit = limit
  }
}

/** The statuses of a final answer that carry no body. */
const BODYLESS_STATUSES = new Set([204, 205, 304])

/**
 * Reports whether an answer can have a body.
 *
 * The budget of the first byte is not armed for the answer of a `HEAD`
 * request and not for the statuses of a final answer that carry no body:
 * there is no first byte to wait for.
 */
export function expectsBody(method: string, status: number): boolean {
  if (method.toUpperCase() === 'HEAD') return false
  return !BODYLESS_STATUSES.has(status)
}

/**
 * The service that runs the exchanges.
 *
 * The service owns the timers of an exchange, the limit of the body, the
 * cancellation and the finalization. The transport owns the socket.
 */
export class HttpExchangeService {
  #transport: HttpTransport
  #onFinalize?: (result: ExchangeResult) => void
  /** The maximum number of exchanges that may run at the same time. */
  #maxConcurrent: number
  /** The exchanges that are running, so a drain can stop them. */
  #active = new Set<{ abort: () => void }>()

  constructor(options: HttpExchangeOptions) {
    this.#transport = options.transport
    this.#onFinalize = options.onFinalize
    this.#maxConcurrent = options.maxConcurrent ?? 0
  }

  /** The number of exchanges that are running. */
  get activeCount(): number {
    return this.#active.size
  }

  /** The maximum number of exchanges that may run at the same time. */
  get maxConcurrent(): number {
    return this.#maxConcurrent
  }

  /** Cancels every exchange that is running. */
  abortAll(): number {
    const running = [...this.#active]
    for (const exchange of running) exchange.abort()
    return running.length
  }

  /**
   * Runs an exchange.
   *
   * The result says what the caller sees: an answer of the upstream, or a
   * failure that the application maps to a status.
   */
  async execute(request: ExchangeRequest): Promise<ExchangeResult> {
    const abort = new AbortController()
    const result: ExchangeResult = {
      response: null,
      failure: null,
      bytesIn: 0,
      bytesOut: 0,
      outcome: 'complete',
    }

    // The cap on the number of exchanges that run at the same time. A
    // client that opens a request and never sends its body holds a
    // connection until the idle budget of the upload runs out: the cap is
    // the bound of that, and it is refused rather than queued.
    if (this.#maxConcurrent > 0 && this.#active.size >= this.#maxConcurrent) {
      result.failure = {
        kind: 'overloaded',
        message: 'the gateway is handling too many requests at the same time',
      }
      result.outcome = 'aborted'
      this.#onFinalize?.(result)
      request.onFinalize?.(result)
      return result
    }

    let finalized = false
    let responseTimer: ReturnType<typeof setTimeout> | undefined
    let uploadTimer: ReturnType<typeof setTimeout> | undefined
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    let uploadComplete = false
    let headersArrived = false
    let firstByteSeen = false
    let uploadTooLarge = false

    const clearTimers = (): void => {
      if (responseTimer) clearTimeout(responseTimer)
      if (uploadTimer) clearTimeout(uploadTimer)
      if (firstByteTimer) clearTimeout(firstByteTimer)
      if (bodyTimer) clearTimeout(bodyTimer)
      responseTimer = undefined
      uploadTimer = undefined
      firstByteTimer = undefined
      bodyTimer = undefined
    }

    const entry = {
      abort: () => {
        fail({ kind: 'aborted', message: 'the exchange was cancelled' })
      },
    }

    const finalize = (): void => {
      if (finalized) return
      finalized = true
      clearTimers()
      this.#active.delete(entry)
      this.#onFinalize?.(result)
      request.onFinalize?.(result)
    }

    const arm = (ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(onTimeout, ms)
      timer.unref?.()
      return timer
    }

    /**
     * The failure of the exchange, as a promise.
     *
     * A budget that runs out has to end the exchange, even when the
     * transport is still waiting for an answer that will never come.
     */
    let reportFailure: (failure: ExchangeFailure) => void = () => undefined
    const failureSignal = new Promise<ExchangeFailure>((resolve) => {
      reportFailure = resolve
    })

    /** Records a failure of the exchange, when the answer was not committed. */
    const fail = (failure: ExchangeFailure): void => {
      if (result.failure || headersArrived) return
      result.failure = failure
      result.outcome = 'aborted'
      abort.abort()
      reportFailure(failure)
      finalize()
    }

    this.#active.add(entry)

    // The caller that goes away cancels the exchange: the request of the
    // upstream is aborted, so a client that is gone does not leave the
    // upstream working.
    const onCallerGone = (): void => {
      fail({ kind: 'aborted', message: 'the caller went away' })
    }
    if (request.signal.aborted) {
      onCallerGone()
      return result
    }
    request.signal.addEventListener('abort', onCallerGone, { once: true })

    // The body that is announced is checked before anything is sent: a
    // request that announces more than the limit is refused without a round
    // trip.
    const declared = request.headers.get('content-length')
    if (request.maxBodyBytes > 0 && declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > request.maxBodyBytes) {
        request.signal.removeEventListener('abort', onCallerGone)
        fail({
          kind: 'too_large',
          message: `the request body is over the limit of ${request.maxBodyBytes} bytes`,
        })
        return result
      }
    }

    /** Arms the budget of the answer of the upstream. */
    const armResponse = (): void => {
      if (headersArrived) return
      if (responseTimer) clearTimeout(responseTimer)
      responseTimer = arm(request.timeouts.responseMs, () => {
        fail({
          kind: 'timeout',
          message: 'the upstream did not answer in time',
        })
      })
    }

    /**
     * The body of the request.
     *
     * The bytes are counted while they pass, the limit is enforced on the
     * bytes that really went through and the idle budget of the upload is
     * rearmed on every chunk.
     */
    const uploadBody = request.body
      ? request.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              result.bytesIn += chunk.byteLength
              if (request.maxBodyBytes > 0 && result.bytesIn > request.maxBodyBytes) {
                uploadTooLarge = true
                controller.error(new PayloadTooLargeError(request.maxBodyBytes))
                return
              }
              if (!uploadComplete) {
                if (uploadTimer) clearTimeout(uploadTimer)
                uploadTimer = arm(request.timeouts.bodyMs, () => {
                  fail({
                    kind: 'timeout',
                    message: 'the request body did not make progress in time',
                  })
                })
              }
              controller.enqueue(chunk)
            },
            flush() {
              uploadComplete = true
              if (uploadTimer) clearTimeout(uploadTimer)
              uploadTimer = undefined
              // The upload is over: the budget of the answer starts now.
              armResponse()
            },
          })
        )
      : null

    if (uploadBody) {
      // The idle budget of the upload is armed right away: a client that
      // sends nothing at all is cut off as well.
      uploadTimer = arm(request.timeouts.bodyMs, () => {
        fail({
          kind: 'timeout',
          message: 'the request body did not make progress in time',
        })
      })
    } else {
      // A request without a body is sent right away: the budget of the
      // answer starts now.
      armResponse()
    }

    const answered = this.#transport
      .send({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: uploadBody,
        signal: abort.signal,
      })
      .then(
        (response) => ({ kind: 'response' as const, response }),
        (error: unknown) => ({ kind: 'error' as const, error })
      )

    const raced = await Promise.race([
      answered,
      failureSignal.then((failure) => ({ kind: 'failure' as const, failure })),
    ])

    if (raced.kind === 'failure') {
      request.signal.removeEventListener('abort', onCallerGone)
      return result
    }

    if (raced.kind === 'error') {
      request.signal.removeEventListener('abort', onCallerGone)
      if (result.failure) {
        // The failure was already recorded (the limit, the timeout or the
        // disconnect).
        return result
      }
      result.failure = uploadTooLarge
        ? { kind: 'too_large', message: 'the request body is over the limit' }
        : {
            kind: request.signal.aborted ? 'aborted' : 'network',
            message: raced.error instanceof Error ? raced.error.message : String(raced.error),
          }
      result.outcome = 'aborted'
      abort.abort()
      finalize()
      return result
    }

    const upstream: UpstreamResponse = raced.response

    request.signal.removeEventListener('abort', onCallerGone)
    if (result.failure) {
      // The exchange failed while the answer was on its way.
      return result
    }

    headersArrived = true
    if (responseTimer) clearTimeout(responseTimer)
    responseTimer = undefined

    const status = upstream.status
    result.status = status

    if (!upstream.body) {
      result.response = {
        status,
        statusText: upstream.statusText,
        headers: upstream.headers,
        body: null,
      }
      finalize()
      return result
    }

    /**
     * The body of the answer.
     *
     * The bytes are counted while they are handed to the downstream
     * runtime, the idle budget of the body is rearmed on every chunk and
     * the budget of the first byte ends the stream when it runs out: the
     * status line was already sent, so the answer cannot be replaced by an
     * error.
     */
    const reader = upstream.body.getReader()
    /** The controller of the stream, so a budget can end it. */
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            finalize()
            return
          }
          if (value) {
            if (!firstByteSeen) {
              firstByteSeen = true
              if (firstByteTimer) {
                // The body of the answer started: the budget of the first
                // byte is over.
                clearTimeout(firstByteTimer)
                firstByteTimer = undefined
              }
              if (bodyTimer) clearTimeout(bodyTimer)
              bodyTimer = arm(request.timeouts.bodyMs, () => {
                result.outcome = 'aborted'
                streamController?.error(
                  new Error('the body of the answer did not make progress in time')
                )
                finalize()
              })
            }
            result.bytesOut += value.byteLength
            controller.enqueue(value)
          }
        } catch (error) {
          result.outcome = 'aborted'
          controller.error(error)
          finalize()
        }
      },
      cancel(reason) {
        result.outcome = 'aborted'
        void reader.cancel(reason).catch(() => undefined)
        finalize()
      },
    })

    result.response = {
      status,
      statusText: upstream.statusText,
      headers: upstream.headers,
      body,
    }

    if (expectsBody(request.method, status)) {
      // The budget of the first byte starts when the answer arrived.
      firstByteTimer = arm(request.timeouts.firstByteMs, () => {
        result.outcome = 'aborted'
        const error = new Error('the upstream did not send the first byte of the body in time')
        streamController?.error(error)
        void reader.cancel(error).catch(() => undefined)
        finalize()
      })
    }

    return result
  }
}
