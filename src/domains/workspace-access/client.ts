/**
 * The client of the access service.
 *
 * The gateway never decides access on its own: it asks the access service
 * and denies the request when no valid decision is available (fail closed).
 *
 * The decisions are cached for a few seconds, so a busy gateway does not ask
 * the access service for every single request. **Only an explicit decision
 * is cached**: a transport failure is not a decision, and caching it would
 * keep denying a caller that the service would have allowed.
 */

import { createHash } from 'node:crypto'
import type { AccessDecision, AccessDecisionKind, AccessRequest } from './decision'

/** The transport of the access service. */
export interface AccessTransport {
  /**
   * Sends a decision request.
   *
   * The answer is the body of the response and its status: the client
   * decides what a status means, the transport only carries it.
   */
  post(options: {
    url: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }): Promise<{ status: number; body: string }>
}

/** A decision of the access service, as it is cached. */
export interface CachedDecision {
  allow: boolean
  /** The kind of the decision: only an explicit one is ever cached. */
  kind: AccessDecisionKind
  reason: string
  decidedAt: number
}

/** The cache of the decisions. */
export interface DecisionCache {
  /** The cached decision of a key, or null. */
  get(key: string): Promise<CachedDecision | null>
  /** Caches a decision for the given number of milliseconds. */
  set(key: string, decision: CachedDecision, ttlMs: number): Promise<void>
  /** Removes the cached decision of a key. */
  delete(key: string): Promise<void>
  /** Closes the cache. */
  close(): Promise<void>
}

/** The settings of the client. */
export interface AccessClientOptions {
  /** The base url of the access service. */
  baseUrl: string
  /** The token the gateway authenticates with. */
  token?: string
  /** How long the gateway waits for a decision. */
  timeoutMs?: number
  /** How long a decision is cached. */
  cacheTtlMs?: number
  /** The transport of the service. */
  transport: AccessTransport
  /** The cache of the decisions. */
  cache: DecisionCache
  /** Called when the service cannot be reached. */
  onError?: (error: unknown) => void
}

/**
 * The key of a cached decision.
 *
 * The roles of the caller are part of the decision: the access service
 * decides on them, so a decision that was made for a caller with a role
 * must never be served to a caller without it. The key is hashed, so the
 * keys of the server stay small and cannot collide by accident.
 */
export function decisionKey(request: AccessRequest): string {
  const roles = [...(request.roles ?? [])].sort().join(',')
  const canonical = JSON.stringify([request.subject, request.workspaceId, request.routeId, roles])
  return createHash('sha256').update(canonical).digest('hex')
}

export class AccessClient {
  #baseUrl: string
  #token?: string
  #timeoutMs: number
  #cacheTtlMs: number
  #transport: AccessTransport
  #cache: DecisionCache
  #onError?: (error: unknown) => void
  /**
   * The decisions that are being asked for, by the key of the cache.
   *
   * The cache of the decisions is empty every time its lifetime is over,
   * and the lifetime is short: a burst of requests for the same decision
   * therefore asks the service once per decision and not once per
   * request. The service that decides the access of the callers is not a
   * cache that is warmed once, and a stampede on it is an outage of the
   * deployment.
   *
   * The entry is removed when the answer arrives: the map holds the calls
   * that are in flight and nothing else.
   */
  #inFlight = new Map<string, Promise<AccessDecision>>()

  constructor(options: AccessClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#timeoutMs = options.timeoutMs ?? 3_000
    this.#cacheTtlMs = options.cacheTtlMs ?? 5_000
    this.#transport = options.transport
    this.#cache = options.cache
    this.#onError = options.onError
  }

  /**
   * Asks the access service whether the subject may use the workspace.
   *
   * Any failure results in a denial.
   *
   * The `fresh` option bypasses the cache: the decision of the service is
   * asked for again. It is used by the revalidation of an open connection,
   * where a decision that was cached a moment ago is exactly the decision
   * that has to be checked.
   *
   * The `cacheTtlMs` option is the lifetime of the cached decision. It is
   * the latency of a revocation on the route that asked for the decision:
   * a route that asks for zero asks the service for every request, so a
   * revocation on that route is immediate.
   */
  async decide(
    request: AccessRequest,
    options: { fresh?: boolean; cacheTtlMs?: number } = {}
  ): Promise<AccessDecision> {
    const key = decisionKey(request)
    if (!options.fresh) {
      const cached = await this.#readCache(key)
      if (cached) {
        return { ...cached, cached: true }
      }
    }

    // The calls that are in flight are shared: a burst of requests for the
    // same decision asks the service once.
    const pending = this.#inFlight.get(key)
    if (pending) {
      const decision = await pending
      return { ...decision, cached: decision.cached }
    }

    const ask = this.#askAndCache(request, key, options)
      .catch((error: unknown) => {
        // The failure of the service is never a crash of the gateway: the
        // caller is refused and the operator sees an outage.
        this.#onError?.(error)
        return {
          allow: false,
          kind: 'unavailable' as const,
          reason: 'the access service is not available',
          cached: false,
          decidedAt: Date.now(),
        }
      })
      .finally(() => {
        this.#inFlight.delete(key)
      })
    this.#inFlight.set(key, ask)
    return await ask
  }

  /**
   * Asks the service and caches the decision it answers.
   *
   * A failure of the service is the unavailability of the service and it
   * is never cached: the service may be able to answer the next request.
   */
  async #askAndCache(
    request: AccessRequest,
    key: string,
    options: { fresh?: boolean; cacheTtlMs?: number }
  ): Promise<AccessDecision> {
    let decision: AccessDecision
    try {
      decision = await this.#ask(request)
    } catch (error) {
      this.#onError?.(error)
      // Fail closed: without a valid decision the request is denied. The
      // failure is not cached: the service may be able to answer the next
      // request.
      //
      // The failure is not a denial either: it is the unavailability of the
      // service, and the caller is told so, so it can retry, and the
      // operator sees it as an outage and not as a policy.
      return {
        allow: false,
        kind: 'unavailable',
        reason: `the access service is not available`,
        cached: false,
        decidedAt: Date.now(),
      }
    }

    const ttlMs = options.cacheTtlMs ?? this.#cacheTtlMs
    if (ttlMs > 0) {
      await this.#writeCache(
        key,
        {
          allow: decision.allow,
          kind: decision.kind,
          reason: decision.reason,
          decidedAt: decision.decidedAt,
        },
        ttlMs
      )
    }
    return decision
  }

  /** Removes the cached decisions. */
  async close(): Promise<void> {
    await this.#cache.close()
  }

  /**
   * Reads a cached decision.
   *
   * A cache that cannot be reached is not a decision: the service is asked
   * again. The cache never changes the answer of a request.
   */
  async #readCache(key: string): Promise<CachedDecision | null> {
    try {
      return await this.#cache.get(key)
    } catch (error) {
      this.#onError?.(error)
      return null
    }
  }

  /** Caches a decision; a cache that cannot be reached is not an error. */
  async #writeCache(key: string, decision: CachedDecision, ttlMs: number): Promise<void> {
    try {
      await this.#cache.set(key, decision, ttlMs)
    } catch (error) {
      this.#onError?.(error)
    }
  }

  /** Sends the decision request and reads the answer. */
  async #ask(request: AccessRequest): Promise<AccessDecision> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    if (this.#token) headers.authorization = `Bearer ${this.#token}`
    const response = await this.#transport.post({
      url: `${this.#baseUrl}/v1/decisions`,
      headers,
      body: JSON.stringify({
        subject: request.subject,
        workspaceId: request.workspaceId,
        routeId: request.routeId,
        roles: request.roles ?? [],
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    // Every failure of the service is the unavailability of the service and
    // not a decision: only an answer that says `allow: false` denies a
    // caller.
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`the access service answered with the status ${response.status}`)
    }
    let body: { allow?: unknown; reason?: unknown }
    try {
      body = JSON.parse(response.body) as { allow?: unknown; reason?: unknown }
    } catch {
      throw new Error('the access service answered with a body that is not json')
    }
    if (typeof body.allow !== 'boolean') {
      throw new Error('the access service answered with a malformed decision')
    }
    return {
      allow: body.allow,
      kind: body.allow ? 'allowed' : 'denied',
      reason: typeof body.reason === 'string' ? body.reason : body.allow ? 'allowed' : 'denied',
      cached: false,
      decidedAt: Date.now(),
    }
  }
}
