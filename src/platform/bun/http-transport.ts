/**
 * The outbound HTTP transport of Bun.
 *
 * The transport sends a request whose body is a stream and hands the
 * response back as a stream. It never follows a redirect, never buffers a
 * body and never decides anything about the exchange: the budgets, the
 * limits and the cancellation belong to the proxying domain.
 *
 * The runtime facts this adapter relies on (they are proved by the tests of
 * `test/network/`):
 *
 * - the promise of `fetch` resolves when the **final** response headers
 *   arrived, the body is still streaming;
 * - an interim response (`103 Early Hints`) is not reported: the final
 *   response is;
 * - a protocol switch (`101`) is refused by the runtime, so it surfaces as
 *   a transport failure and the exchange answers `502`;
 * - a request with a streaming body is sent while it is produced, and the
 *   runtime closes the body stream when the upstream answers before the
 *   upload is over.
 * - the answer is not decompressed: the bytes of the upstream and its
 *   `content-encoding` reach the caller as they are.
 */

import type { HttpTransport, UpstreamRequest, UpstreamResponse } from '../../domains/proxying'

/** The options of the transport. */
export interface BunHttpTransportOptions {
  /**
   * Injected for the tests: the transport is the only place that talks to
   * the network of the runtime.
   */
  fetchImpl?: typeof fetch
}

/** A request with a body needs the `duplex` option of the runtime. */
type StreamingRequestInit = RequestInit & { duplex: 'half' }

export class BunHttpTransport implements HttpTransport {
  #fetch: typeof fetch

  constructor(options: BunHttpTransportOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch
  }

  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      // A redirect is the business of the caller: the gateway never follows
      // one, it forwards the answer of the upstream as it is.
      redirect: 'manual',
    }
    // The answer of the upstream is forwarded as it is: a compressed body
    // stays compressed and keeps its `content-encoding`. The runtime
    // decompresses the answers by default, which would change the bytes the
    // caller receives and the length the upstream announced.
    Object.assign(init, { decompress: false })
    if (request.body) {
      Object.assign(init, { body: request.body, duplex: 'half' } satisfies StreamingRequestInit)
    }

    const response = await this.#fetch(request.url, init as RequestInit)

    // A protocol switch is not an answer of the http path: the websocket
    // upgrade owns it. The runtime refuses the switch anyway, and this is
    // the guard for the runtimes that would not.
    if (response.status === 101) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('the upstream answered with a protocol switch')
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
    }
  }
}
