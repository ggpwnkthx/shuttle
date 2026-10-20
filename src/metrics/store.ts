/**
 * The metrics of the gateway, in the Prometheus text exposition format.
 *
 * The exposition format is produced by `prom-client`, nothing here is
 * hand-rolled: the library owns the format, the escaping and the histogram
 * buckets. This module only decides *what* is measured and keeps the number
 * of label combinations bounded, so a busy gateway can never grow its
 * memory without limit.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client'

/** Number of routes that are tracked individually. */
const MAX_TRACKED_ROUTES = 500

/** The label value used for the routes that do not fit any more. */
const OVERFLOW_ROUTE = 'overflow'

/** Upper bounds of the latency histogram, in seconds. */
const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
]

/**
 * The reasons a caller was rejected. They are a closed set on purpose.
 *
 * `missing_role` is not a decision of the gateway: Shuttle does not check
 * roles itself. It is reported when the access service denies a caller
 * because of a missing role.
 */
export type AuthFailureReason = 'unauthenticated' | 'missing_role' | 'access_denied'

export interface RequestObservation {
  routeId: string
  method: string
  status: number
  durationMs: number
  bytesIn: number
  bytesOut: number
}

export class MetricsStore {
  #registry = new Registry()
  #requests: Counter<'route' | 'method' | 'status'>
  #errors: Counter<'route'>
  #authFailures: Counter<'route' | 'reason'>
  #websockets: Counter<'route'>
  #duration: Histogram<'route'>
  #bytesIn: Counter
  #bytesOut: Counter
  #active: Gauge
  #configReloads: Counter<'result'>
  #rateLimited: Counter
  #crossSiteRefusals: Counter<'route'>
  #websocketRefusals: Counter<'reason'>
  #sharedStateErrors: Counter
  /** The routes that are tracked individually. */
  #routes = new Set<string>()
  #startedAt = Date.now()

  constructor() {
    this.#requests = new Counter({
      name: 'shuttle_requests_total',
      help: 'Requests handled by the gateway.',
      labelNames: ['route', 'method', 'status'],
      registers: [this.#registry],
    })
    this.#errors = new Counter({
      name: 'shuttle_request_errors_total',
      help: 'Requests that failed with a server error.',
      labelNames: ['route'],
      registers: [this.#registry],
    })
    this.#authFailures = new Counter({
      name: 'shuttle_auth_failures_total',
      help: 'Callers that were rejected.',
      labelNames: ['route', 'reason'],
      registers: [this.#registry],
    })
    this.#websockets = new Counter({
      name: 'shuttle_websocket_connections_total',
      help: 'Accepted websocket upgrades.',
      labelNames: ['route'],
      registers: [this.#registry],
    })
    this.#duration = new Histogram({
      name: 'shuttle_request_duration_seconds',
      help: 'Latency of the proxied requests.',
      labelNames: ['route'],
      buckets: DURATION_BUCKETS_SECONDS,
      registers: [this.#registry],
    })
    this.#bytesIn = new Counter({
      name: 'shuttle_bytes_in_total',
      help: 'Bytes received from the callers.',
      registers: [this.#registry],
    })
    this.#bytesOut = new Counter({
      name: 'shuttle_bytes_out_total',
      help: 'Bytes sent to the callers.',
      registers: [this.#registry],
    })
    this.#active = new Gauge({
      name: 'shuttle_active_requests',
      help: 'Requests that are currently in flight.',
      registers: [this.#registry],
    })
    this.#configReloads = new Counter({
      name: 'shuttle_config_reloads_total',
      help: 'Configuration reloads by outcome.',
      labelNames: ['result'],
      registers: [this.#registry],
    })
    this.#rateLimited = new Counter({
      name: 'shuttle_rate_limited_total',
      help: 'Requests that were refused by the rate limiter.',
      registers: [this.#registry],
    })
    this.#crossSiteRefusals = new Counter({
      name: 'shuttle_cross_site_refusals_total',
      help: 'Requests that were refused because they came from another site.',
      labelNames: ['route'],
      registers: [this.#registry],
    })
    this.#websocketRefusals = new Counter({
      name: 'shuttle_websocket_refusals_total',
      help: 'Websocket handshakes that were refused, by reason.',
      labelNames: ['reason'],
      registers: [this.#registry],
    })
    this.#sharedStateErrors = new Counter({
      name: 'shuttle_shared_state_errors_total',
      help: 'The times the state the replicas share was not reachable.',
      registers: [this.#registry],
    })
  }

  get startedAt(): number {
    return this.#startedAt
  }

  /** The content type of the exposition format. */
  get contentType(): string {
    return this.#registry.contentType
  }

  requestStarted(): void {
    this.#active.inc()
  }

  requestFinished(): void {
    this.#active.dec()
  }

  /** Records a proxied request. */
  recordRequest(observation: RequestObservation): void {
    const route = this.#route(observation.routeId)
    this.#requests.inc({
      route,
      method: observation.method,
      status: String(observation.status),
    })
    if (observation.status >= 500) this.#errors.inc({ route })
    this.#bytesIn.inc(observation.bytesIn)
    this.#bytesOut.inc(observation.bytesOut)
    this.#duration.observe({ route }, observation.durationMs / 1000)
  }

  /** Records a rejected caller. */
  recordAuthFailure(routeId: string, reason: AuthFailureReason): void {
    this.#authFailures.inc({ route: this.#route(routeId), reason })
  }

  /** Records an accepted websocket upgrade. */
  recordWebsocket(routeId: string): void {
    this.#websockets.inc({ route: this.#route(routeId) })
  }

  /** Records the outcome of a configuration reload. */
  recordConfigReload(ok: boolean): void {
    this.#configReloads.inc({ result: ok ? 'ok' : 'failed' })
  }

  /** Records a request that the rate limiter refused. */
  recordRateLimit(_client: string): void {
    // The client is not a label: an unbounded set of addresses would grow
    // the metrics without limit.
    this.#rateLimited.inc()
  }

  /** Records a request that came from another site. */
  recordCrossSiteRefusal(routeId: string): void {
    this.#crossSiteRefusals.inc({ route: this.#route(routeId) })
  }

  /** Records a websocket handshake that was refused. */
  recordWebsocketRefusal(reason: 'connection_limit' | 'upstream_unavailable'): void {
    this.#websocketRefusals.inc({ reason })
  }

  /**
   * Records that the state the replicas share was not reachable.
   *
   * The rate limiter fails open and the cache of the decisions is skipped,
   * so a hiccup of the server does not change the answer of a request. It
   * does mean the limits of the deployment are not enforced.
   */
  recordSharedStateError(): void {
    this.#sharedStateErrors.inc()
  }

  /** A snapshot of the counters, used by the tests. */
  async totals(): Promise<{
    requests: number
    errors: number
    authFailures: number
    bytesIn: number
    bytesOut: number
    websockets: number
    active: number
  }> {
    const [requests, errors, authFailures, bytesIn, bytesOut, websockets, active] =
      await Promise.all([
        this.#sum(this.#requests),
        this.#sum(this.#errors),
        this.#sum(this.#authFailures),
        this.#sum(this.#bytesIn),
        this.#sum(this.#bytesOut),
        this.#sum(this.#websockets),
        this.#sum(this.#active),
      ])
    return { requests, errors, authFailures, bytesIn, bytesOut, websockets, active }
  }

  /** Renders the metrics in the Prometheus text exposition format. */
  async render(): Promise<string> {
    return this.#registry.metrics()
  }

  /** The sum of every label combination of a metric. */
  async #sum(metric: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> {
    const snapshot = await metric.get()
    return snapshot.values.reduce((total, entry) => total + entry.value, 0)
  }

  /**
   * The label value of a route.
   *
   * Routes beyond the cap are aggregated into a single `overflow` series, so
   * the memory stays bounded.
   */
  #route(routeId: string): string {
    if (this.#routes.has(routeId)) return routeId
    if (this.#routes.size >= MAX_TRACKED_ROUTES) {
      this.#routes.add(OVERFLOW_ROUTE)
      return OVERFLOW_ROUTE
    }
    this.#routes.add(routeId)
    return routeId
  }
}
