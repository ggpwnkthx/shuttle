/**
 * The transport of the access service.
 *
 * The transport carries the request of a decision and the answer of the
 * service. It makes no decision: the domain decides what a status means and
 * what a body is.
 */

import type { AccessTransport } from '../../domains/workspace-access'

export interface FetchAccessTransportOptions {
  /** The fetch of the runtime; injected for the tests. */
  fetchImpl?: typeof fetch
}

export class FetchAccessTransport implements AccessTransport {
  #fetch: typeof fetch

  constructor(options: FetchAccessTransportOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch
  }

  async post(options: {
    url: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }): Promise<{ status: number; body: string }> {
    const response = await this.#fetch(options.url, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    })
    return { status: response.status, body: await response.text() }
  }
}
