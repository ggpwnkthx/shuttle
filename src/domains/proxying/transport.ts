/**
 * The outbound HTTP transport of the gateway.
 *
 * The proxying domain owns the *state machine* of an exchange: the budgets
 * of the phases, the limit of the body, the cancellation and the moment the
 * answer is committed. The transport owns the *socket*: it sends a prepared
 * request to an upstream and hands the response back as a stream.
 *
 * The two are separated on purpose: the rules of the exchange do not depend
 * on the runtime, and the runtime does not decide anything about the
 * exchange.
 *
 * The events the transport reports:
 *
 * - `send` resolves when the **final** response headers arrived. An interim
 *   response (a `103 Early Hints`) is not reported: the gateway forwards
 *   the final response only.
 * - the body of the response is a stream: the first byte and the progress
 *   are observed by the reader of the stream, not by the transport.
 * - a protocol switch (`101`) is not a response of the http path: the
 *   transport refuses it and the exchange answers `502`.
 */

export interface UpstreamRequest {
  /** The absolute url of the upstream, with the query string of the request. */
  url: string
  /** The method of the request, upper cased. */
  method: string
  /** The headers of the request, already filtered by the forwarding domain. */
  headers: Headers
  /**
   * The body of the request.
   *
   * It is a stream and never a buffer: a large upload and a server sent
   * event stream have to work without the gateway holding them in memory.
   */
  body: ReadableStream<Uint8Array> | null
  /** Aborted when the caller goes away or when the exchange is cancelled. */
  signal: AbortSignal
}

export interface UpstreamResponse {
  status: number
  statusText: string
  headers: Headers
  /** The body of the response, or null when the response has no body. */
  body: ReadableStream<Uint8Array> | null
}

/**
 * The port of the outbound transport.
 *
 * The implementation lives in the platform layer; the domain never sees the
 * runtime it runs on.
 */
export interface HttpTransport {
  /**
   * Sends the request and resolves when the final response headers arrived.
   *
   * The rejection means that no answer was committed: the exchange answers
   * `502 bad_gateway`, or `504 gateway_timeout` when its budget ran out.
   */
  send(request: UpstreamRequest): Promise<UpstreamResponse>
}
