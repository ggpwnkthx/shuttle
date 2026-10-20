/**
 * Client for the external workspace access service.
 *
 * The gateway never decides access on its own: it asks the access service and
 * denies the request when no valid decision is available (fail closed).
 */

import type { AuthFailureReason } from '../metrics/store'
import {
  MemoryDecisionCache,
  type CachedDecision,
  type DecisionCache,
} from './decision-cache'

/**
 * Maps the reason of a denial to the reason of the metric.
 *
 * The gateway does not check roles itself, so a denial that is about a role
 * comes from the access service. It is counted separately, because a caller
 * that misses a role and a caller that does not belong to the workspace are
 * different problems.
 */
export function authFailureReason(reason: string): AuthFailureReason {
  return /role/i.test(reason) ? 'missing_role' : 'access_denied'
}

export interface AccessDecision {
  allow: boolean
  reason: string
  /** True when the decision was served from the local cache. */
  cached: boolean
  decidedAt: number
}

export interface AccessRequest {
  subject: string
  workspaceId: string
  routeId: string
  roles?: string[]
}

export interface AccessClientOptions {
  baseUrl: string
  /** Service token used to authenticate against the access service. */
  token?: string
  timeoutMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  fetchImpl?: typeof fetch
  onError?: (error: unknown) => void
  /**
   * Where the decisions are cached.
   *
   * A deployment with more than one replica uses a cache every replica
   * shares, so all of them answer with the same decision.
   */
  cache?: DecisionCache
}

export class AccessClient {
  #baseUrl: string
  #token?: string
  #timeoutMs: number
  #cacheTtlMs: number
  #fetch: typeof fetch
  #onError?: (error: unknown) => void
  /** The cached decisions. */
  #cache: DecisionCache

  constructor(options: AccessClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#timeoutMs = options.timeoutMs ?? 3_000
    this.#cacheTtlMs = options.cacheTtlMs ?? 5_000
    this.#fetch = options.fetchImpl ?? fetch
    this.#onError = options.onError
    this.#cache =
      options.cache ??
      new MemoryDecisionCache({ maxEntries: options.maxCacheEntries ?? 1_000 })
  }

  /**
   * The key of a cached decision.
   *
   * The roles of the caller are part of the decision: the access service
   * decides on them, so a decision that was made for a caller with a role
   * must never be served to a caller without it.
   */
  #cacheKey(request: AccessRequest): string {
    const roles = [...(request.roles ?? [])].sort().join(',')
    return `${request.subject}|${request.workspaceId}|${request.routeId}|${roles}`
  }
  /**
   * Asks the access service whether the subject may use the workspace.
   * Any failure results in a denial.
   */
  async decide(request: AccessRequest): Promise<AccessDecision> {
    const key = this.#cacheKey(request)
    const cached = await this.#cache.get(key)
    if (cached) {
      return { ...cached, cached: true }
    }

    let decision: AccessDecision
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      }
      if (this.#token) headers.authorization = `Bearer ${this.#token}`
      const response = await this.#fetch(`${this.#baseUrl}/v1/decisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          subject: request.subject,
          workspaceId: request.workspaceId,
          routeId: request.routeId,
          roles: request.roles ?? [],
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`access service returned ${response.status}`)
      }
      const body = (await response.json()) as { allow?: unknown; reason?: unknown }
      if (typeof body.allow !== 'boolean') {
        throw new Error('access service returned a malformed decision')
      }
      decision = {
        allow: body.allow,
        reason: typeof body.reason === 'string' ? body.reason : body.allow ? 'allowed' : 'denied',
        cached: false,
        decidedAt: Date.now(),
      }
    } catch (error) {
      this.#onError?.(error)
      // Fail closed: without a valid decision the request is denied.
      decision = {
        allow: false,
        reason: `access service unavailable: ${error instanceof Error ? error.message : String(error)}`,
        cached: false,
        decidedAt: Date.now(),
      }
    }

    if (this.#cacheTtlMs > 0) {
      const value: CachedDecision = {
        allow: decision.allow,
        reason: decision.reason,
        decidedAt: decision.decidedAt,
      }
      await this.#cache.set(key, value, this.#cacheTtlMs)
    }
    return decision
  }

  /** Removes the cached decisions. */
  async close(): Promise<void> {
    await this.#cache.close()
  }
}
