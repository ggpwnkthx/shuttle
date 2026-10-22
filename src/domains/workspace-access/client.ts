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
import { AccessBreaker } from './breaker'
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
  /**
   * How long a decision may be served after the service became unreachable.
   *
   * Zero disables it: an unreachable service is an outage and the gateway
   * answers `503` to it, which is the behaviour that tells the operator
   * that the service is down.
   */
  staleGraceMs?: number
  /** The transport of the service. */
  transport: AccessTransport
  /** The cache of the decisions. */
  cache: DecisionCache
  /**
   * The number of failures of the service before it is not called any
   * more, and how long it is not called.
   *
   * Zero disables the breaker: the service is called on every request, and
   * a request waits for the whole budget of the call when the service does
   * not answer.
   */
  breaker?: { failures?: number; cooldownMs?: number }
  /** Called when the service cannot be reached. */
  onError?: (error: unknown) => void
  /**
   * Called when the service is not called any more because it failed.
   *
   * The traffic of the routes that need a decision is refused without a
   * call while the breaker is open, so the operator has to see that the
   * service is not being called at all.
   */
  onBreakerOpen?: () => void
  /** Called when the service answered again after a failure. */
  onBreakerRecovery?: () => void
  /**
   * Called after every call that reached the service.
   *
   * The duration is the latency of the service, and it is reported only for
   * the calls that were actually made: a decision that came from the cache
   * did not cost a call.
   */
  onDecision?: (routeId: string, durationMs: number) => void
  /**
   * Called when a decision was served while the service was unreachable.
   *
   * The route and the age of the decision are reported: the age is the
   * time the decision was old when it was served.
   */
  onStale?: (routeId: string, ageMs: number) => void
}

/**
 * The key of a cached decision.
 *
 * The roles of the caller are part of the decision: the access service
 * decides on them, so a decision that was made for a caller with a role
 * must never be served to a caller without it. The key is hashed, so the
 * keys of the server stay small and cannot collide by accident.
 *
 * The workspace is part of the key as well. A route that names no
 * workspace has its own decisions, and they are never served to a route
 * that names one.
 */
export function decisionKey(request: AccessRequest): string {
  // Preserve role boundaries: ['admin,user'] and ['admin', 'user'] are
  // different role lists even though joining them would produce the same text.
  const roles = [...(request.roles ?? [])].sort()
  const canonical = JSON.stringify([
    request.subject,
    request.workspaceId ?? '',
    request.routeId,
    roles,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

export class AccessClient {
  #baseUrl: string
  #token?: string
  #timeoutMs: number
  #cacheTtlMs: number
  #staleGraceMs: number
  #transport: AccessTransport
  #cache: DecisionCache
  #breaker: AccessBreaker
  #onError?: (error: unknown) => void
  #onDecision?: (routeId: string, durationMs: number) => void
  #onStale?: (routeId: string, ageMs: number) => void
  #onBreakerOpen?: () => void
  #onBreakerRecovery?: () => void
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
    this.#staleGraceMs = options.staleGraceMs ?? 0
    this.#transport = options.transport
    this.#cache = options.cache
    this.#onError = options.onError
    this.#onDecision = options.onDecision
    this.#onStale = options.onStale
    this.#onBreakerOpen = options.onBreakerOpen
    this.#onBreakerRecovery = options.onBreakerRecovery
    this.#breaker = new AccessBreaker({
      failures: options.breaker?.failures,
      cooldownMs: options.breaker?.cooldownMs,
      onOpen: () => this.#onBreakerOpen?.(),
      onRecovery: () => this.#onBreakerRecovery?.(),
    })
  }

  /** The state of the breaker of the service. */
  get breakerState(): 'closed' | 'open' | 'half-open' {
    return this.#breaker.state
  }

  /**
   * Asks the access service whether the subject may use the workspace.
   *
   * Any failure results in a denial.
   *
   * The `fresh` option bypasses the cache: the decision of the service is
   * asked for again. It is used by the revalidation of an open connection,
   * where a decision that was cached a moment ago is exactly the decision
   * that has to be checked. A fresh decision is never stale: a connection
   * whose access was revoked has to be closed, and a decision that is
   * served from the grace would keep it open.
   *
   * The `cacheTtlMs` option is the lifetime of the cached decision. It is
   * the latency of a revocation on the route that asked for the decision:
   * a route that asks for zero asks the service for every request, so a
   * revocation on that route is immediate.
   *
   * The `staleGraceMs` option is the time a decision may be served after
   * the service became unreachable. Zero disables it.
   */
  async decide(
    request: AccessRequest,
    options: { fresh?: boolean; cacheTtlMs?: number; staleGraceMs?: number } = {}
  ): Promise<AccessDecision> {
    const key = decisionKey(request)
    const cacheTtlMs = options.cacheTtlMs ?? this.#cacheTtlMs
    const staleGraceMs = options.staleGraceMs ?? this.#staleGraceMs
    // The decision that is too old to be served as it is, but that may be
    // served while the service is unreachable.
    let stale: CachedDecision | null = null
    if (!options.fresh) {
      const cached = await this.#readCache(key)
      if (cached) {
        const age = Date.now() - cached.decidedAt
        if (age <= cacheTtlMs) {
          return { ...cached, cached: true, stale: false, shortCircuited: false }
        }
        if (staleGraceMs > 0 && age <= cacheTtlMs + staleGraceMs) {
          stale = cached
        }
      }
    }

    // The calls that are in flight are shared: a burst of requests for the
    // same decision asks the service once.
    const pending = this.#inFlight.get(key)
    if (pending) {
      const decision = await pending
      return this.#serveStale(decision, stale, request.routeId)
    }

    // The breaker of the service. When it failed recently it is not
    // called, and the request is answered **at once** with the
    // unavailability of the service: waiting for a call that is going to
    // fail would make the outage slower, and the slower gateway falls
    // further behind.
    //
    // The grace of an outage still applies: a decision that allows the
    // caller and is still inside the grace is served, so a route that
    // asked for the grace keeps its traffic while the service is down.
    if (!this.#breaker.allowCall()) {
      const decision: AccessDecision = {
        allow: false,
        kind: 'unavailable',
        reason: 'the access service is not available',
        cached: false,
        stale: false,
        decidedAt: Date.now(),
        shortCircuited: true,
      }
      return this.#serveStale(decision, stale, request.routeId)
    }

    const ask = this.#askAndCache(request, key, { cacheTtlMs, staleGraceMs })
      .catch((error: unknown) => {
        // The failure of the service is never a crash of the gateway: the
        // caller is refused and the operator sees an outage.
        this.#onError?.(error)
        return {
          allow: false,
          kind: 'unavailable' as const,
          reason: 'the access service is not available',
          cached: false,
          stale: false,
          decidedAt: Date.now(),
          shortCircuited: false,
        }
      })
      .finally(() => {
        this.#inFlight.delete(key)
      })
    this.#inFlight.set(key, ask)
    const decision = await ask
    return this.#serveStale(decision, stale, request.routeId)
  }

  /**
   * Serves the last decision of the service while the service is down.
   *
   * The decision is served only when it allows the caller: the grace
   * exists so that an outage of the service does not take the traffic of
   * the deployment down. A denial that is served instead of the outage
   * would hide the outage from the operator, and the refusal of the caller
   * is the same answer as the refusal of a fail-closed gateway.
   */
  #serveStale(
    decision: AccessDecision,
    stale: CachedDecision | null,
    routeId: string
  ): AccessDecision {
    if (decision.kind !== 'unavailable' || !stale || !stale.allow) return decision
    const age = Date.now() - stale.decidedAt
    this.#onStale?.(routeId, age)
    return {
      allow: true,
      kind: 'allowed',
      reason: stale.reason,
      cached: true,
      stale: true,
      decidedAt: stale.decidedAt,
      shortCircuited: false,
    }
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
    options: { cacheTtlMs?: number; staleGraceMs?: number }
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
        stale: false,
        decidedAt: Date.now(),
        shortCircuited: false,
      }
    }

    const ttlMs = options.cacheTtlMs ?? this.#cacheTtlMs
    const graceMs = options.staleGraceMs ?? this.#staleGraceMs
    // The entry lives longer than the lifetime of the decision: the grace
    // needs the decision to still be there when the service is down.
    const lifetime = ttlMs + graceMs
    if (lifetime > 0) {
      await this.#writeCache(
        key,
        {
          allow: decision.allow,
          kind: decision.kind,
          reason: decision.reason,
          decidedAt: decision.decidedAt,
        },
        lifetime
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
    const startedAt = Date.now()
    let response: { status: number; body: string }
    try {
      // The workspace is only in the request when the route names one: a
      // route that asks the access service about itself sends the subject,
      // the route and the roles, and the service decides without a
      // workspace.
      const payload: Record<string, unknown> = {
        subject: request.subject,
        routeId: request.routeId,
        roles: request.roles ?? [],
      }
      if (request.workspaceId !== undefined) payload.workspaceId = request.workspaceId
      response = await this.#transport.post({
        url: `${this.#baseUrl}/v1/decisions`,
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      // The call did not answer: the service is unreachable or it did not
      // answer in time. The breaker counts the failure.
      this.#breaker.reportFailure()
      throw error
    } finally {
      // The latency of the service is reported whether it answered or not:
      // a service that times out is slow, and an operator looks at this
      // number to see it.
      this.#onDecision?.(request.routeId, Date.now() - startedAt)
    }
    // Every failure of the service is the unavailability of the service and
    // not a decision: only an answer that says `allow: false` denies a
    // caller.
    if (response.status < 200 || response.status >= 300) {
      // A `400` is the gateway's own fault: the service refused the
      // request the gateway sent. It is reported, but it does not open the
      // breaker: a bug in the gateway must not refuse every caller of the
      // deployment by opening the breaker of the service.
      if (response.status !== 400) this.#breaker.reportFailure()
      throw new Error(`the access service answered with the status ${response.status}`)
    }
    let body: { allow?: unknown; reason?: unknown }
    try {
      body = JSON.parse(response.body) as { allow?: unknown; reason?: unknown }
    } catch {
      this.#breaker.reportFailure()
      throw new Error('the access service answered with a body that is not json')
    }
    if (typeof body.allow !== 'boolean') {
      this.#breaker.reportFailure()
      throw new Error('the access service answered with a malformed decision')
    }
    // The service answered: it is healthy again. The breaker counts a
    // denial as a success: the service did its job.
    this.#breaker.reportSuccess()
    return {
      allow: body.allow,
      kind: body.allow ? 'allowed' : 'denied',
      reason: typeof body.reason === 'string' ? body.reason : body.allow ? 'allowed' : 'denied',
      cached: false,
      stale: false,
      decidedAt: Date.now(),
      shortCircuited: false,
    }
  }
}
