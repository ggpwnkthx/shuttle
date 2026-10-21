/**
 * The answers of the gateway itself.
 *
 * The gateway refuses a request with a json body that names the error and
 * says what happened. The bodies of the upstreams are never invented by the
 * gateway: an answer of an upstream is forwarded as it is.
 */

/** The body of a refusal of the gateway. */
interface GatewayErrorBody {
  error: string
  message: string
  [key: string]: unknown
}

/**
 * Builds the answer of a refusal of the gateway.
 *
 * The body is `{"error": <code>, "message": <text>}`: the code is the
 * machine readable name of the failure, the text says what happened.
 *
 * The headers are added to the answer: a refusal that may be retried
 * carries a `retry-after`, and the caller knows it may come back.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  const body: GatewayErrorBody = { error: code, message, ...extra }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * The answer of a caller that went away.
 *
 * There is nobody to answer, but the status is recorded: the number of the
 * callers that went away is worth knowing.
 */
export function clientGoneResponse(): Response {
  return new Response(null, { status: 499 })
}
