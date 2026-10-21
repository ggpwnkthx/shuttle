/**
 * The metrics of the gateway.
 *
 * The exposition format is produced by `prom-client`, nothing here is
 * hand-rolled: the library owns the format, the escaping and the histogram
 * buckets. This module decides *what* is measured and keeps the number of
 * label combinations bounded, so a busy gateway can never grow its memory
 * without limit.
 *
 * The labels are bounded on purpose: the route (or a fixed value for the
 * requests that matched no route), the method, the status and a closed set
 * of reasons. A workspace, a subject, an url or a request id are never a
 * label.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client'

/** The number of routes that are tracked individually. */
const MAX_TRACKED_ROUTES = 500

/** The label value used for the routes that do not fit any more. */
const OVERFLOW_ROUTE = 'overflow'

/** The label value used for the requests that matched no route. */
export const UNMATCHED_ROUTE = 'unmatched'

/**
 * The label value used for the methods that are not tracked individually.
 *
 * The method of a request is chosen by the client: a client that sends an
 * unusual method would create a series per method without bound. The
 * methods that a deployment really uses keep their name, the others are
 * counted together.
 */
export const OTHER_METHOD = 'other'

/**
 * The methods that are tracked individually.
 *
 * They are the methods of the specification of HTTP and the one of the
 * WebDAV extension that a gateway realistically sees.
 */
const TRACKED_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'PROPFIND',
  'PROPPATCH',
  'MKCOL',
  'COPY',
  'MOVE',
  'LOCK',
  'UNLOCK',
  'REPORT',
  'SEARCH',
])

/**
 * The label value used for the statuses that are not tracked individually.
 *
 * The status of an answer is chosen by the upstream: an upstream that
 * answers with an unusual status would create a series per status without
 * bound. The statuses that carry a meaning for an operator keep their
 * number, the others are counted together.
 */
export const OTHER_STATUS = 'other'

/**
 * The statuses that are tracked individually.
 *
 * They are the statuses of the specification of HTTP, the ones the gateway
 * generates itself and the two that an operator looks for: the redirect of
 * the login and the refusal of the cross-site guard.
 */
const TRACKED_STATUSES: ReadonlySet<number> = new Set([
  100, 101, 200, 201, 202, 203, 204, 206, 300, 301, 302, 303, 304, 307, 308, 400, 401, 402, 403,
  404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424,
  425, 426, 428, 429, 431, 451, 499, 500, 501, 502, 503, 504, 505, 507, 508, 510, 511,
])

/**
 * The label value of a method.
 *
 * The method is upper-cased: a client that sends `get` and a client that
 * sends `GET` are counted together.
 */
export function methodLabel(method: string): string {
  const upper = method.toUpperCase()
  return TRACKED_METHODS.has(upper) ? upper : OTHER_METHOD
}

/**
 * The label value of a status.
 *
 * A status that is not tracked individually is counted as `other`, so the
 * number of series of the metric stays bounded whatever the upstream
 * answers.
 */
export function statusLabel(status: number): string {
  return TRACKED_STATUSES.has(status) ? String(status) : OTHER_STATUS
}

/** Upper bounds of the latency histogram, in seconds. */
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]

/**
 * The reasons a caller was rejected. They are a closed set on purpose.
 *
 * `missing_role` is not a decision of the gateway: Shuttle does not check
 * roles itself. It is reported when the access service denies a caller
 * because of a missing role.
 */
export type AuthFailureReason = 'unauthenticated' | 'missing_role' | 'access_denied'

/** The reasons a websocket handshake was refused. */
export type WebSocketRefusalReason =
  | 'connection_limit'
  | 'upstream_unavailable'
  | 'upstream_refused'
  | 'cross_site'
  | 'not_allowed'

/** The observation of a request that was handled. */
export interface RequestObservation {
  /** The id of the route, or the fixed value of the unmatched requests. */
  routeId: string
  method: string
  status: number
  durationMs: number
  bytesIn: number
  bytesOut: number
}

/**
 * The interface the application uses to observe the gateway.
 *
 * The application knows the interface and not the implementation: the
 * metrics are an observation, they are not a policy of the request.
 */
export interface Observer {
  /** A request started. */
  requestStarted(): void
  /** A request is over. */
  requestFinished(): void
  /** A request was handled. */
  recordRequest(observation: RequestObservation): void
  /** A caller was rejected. */
  recordAuthFailure(routeId: string, reason: AuthFailureReason): void
  /** The upstream answered a request. */
  recordUpstream(routeId: string, durationMs: number): void
  /** An upstream failed: the connection was refused, or the attempt ran out of time. */
  recordUpstreamFailure(): void
  /** An upstream was skipped because it failed recently. */
  recordUpstreamSkipped(): void
  /** The access service answered a decision request. */
  recordAccess(routeId: string, durationMs: number): void
  /** The access service could not be asked. */
  recordAccessUnavailable(routeId: string): void
  /**
   * A decision was served while the access service was unreachable.
   *
   * The age of the decision is reported: it is the time the revocation of
   * the caller was late by.
   */
  recordAccessStale(routeId: string, ageMs: number): void
  /** A websocket was accepted. */
  recordWebsocket(routeId: string): void
  /** A websocket handshake was refused. */
  recordWebsocketRefusal(reason: WebSocketRefusalReason): void
  /** A configuration was loaded. */
  recordConfigReload(ok: boolean): void
  /** A request was refused by the limiter. */
  recordRateLimit(): void
  /** A request was refused because it came from another site. */
  recordCrossSiteRefusal(routeId: string): void
  /** The state the replicas share was not reachable. */
  recordSharedStateError(): void
  /** The metrics, in the Prometheus text exposition format. */
  render(): Promise<string>
  /** The content type of the exposition format. */
  readonly contentType: string
}

export class MetricsStore implements Observer {
  #registry = new Registry()
  #requests: Counter<'route' | 'method' | 'status'>
  #errors: Counter<'route'>
  #authFailures: Counter<'route' | 'reason'>
  #accessUnavailable: Counter<'route'>
  #accessStale: Counter<'route'>
  #accessStaleAge: Histogram<'route'>
  #websockets: Counter<'route'>
  #duration: Histogram<'route'>
  #upstreamDuration: Histogram<'route'>
  #accessDuration: Histogram<'route'>
  #bytesIn: Counter
  #bytesOut: Counter
  #active: Gauge
  #configReloads: Counter<'result'>
  #rateLimited: Counter
  #crossSiteRefusals: Counter<'route'>
  #websocketRefusals: Counter<'reason'>
  #sharedStateErrors: Counter
  #upstreamFailures: Counter
  #upstreamsSkipped: Counter
  /** The routes that are tracked individually. */
  #routes = new Set<string>()

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
    this.#accessUnavailable = new Counter({
      name: 'shuttle_access_unavailable_total',
      help: 'Requests that were refused because the access service could not be reached.',
      labelNames: ['route'],
      registers: [this.#registry],
    })
    this.#accessStale = new Counter({
      name: 'shuttle_access_stale_total',
      help: 'Decisions that were served while the access service was unreachable.',
      labelNames: ['route'],
      registers: [this.#registry],
    })
    this.#accessStaleAge = new Histogram({
      name: 'shuttle_access_stale_age_seconds',
      help: 'The age of the decisions that were served while the access service was unreachable.',
      labelNames: ['route'],
      buckets: [1, 5, 15, 30, 60, 300, 900, 3_600],
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
    this.#upstreamDuration = new Histogram({
      name: 'shuttle_upstream_duration_seconds',
      help: 'Latency of the upstreams.',
      labelNames: ['route'],
      buckets: DURATION_BUCKETS_SECONDS,
      registers: [this.#registry],
    })
    this.#accessDuration = new Histogram({
      name: 'shuttle_access_duration_seconds',
      help: 'Latency of the calls to the access service.',
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
    this.#upstreamFailures = new Counter({
      name: 'shuttle_upstream_failures_total',
      help: 'The failures of the upstreams: a connection that was refused, an attempt that ran out of time.',
      registers: [this.#registry],
    })
    this.#upstreamsSkipped = new Counter({
      name: 'shuttle_upstreams_skipped_total',
      help: 'The times an upstream was skipped because it failed recently.',
      registers: [this.#registry],
    })
  }

  requestStarted(): void {
    this.#active.inc()
  }

  requestFinished(): void {
    this.#active.dec()
  }

  recordRequest(observation: RequestObservation): void {
    const route = this.#route(observation.routeId)
    this.#requests.inc({
      route,
      method: methodLabel(observation.method),
      status: statusLabel(observation.status),
    })
    if (observation.status >= 500) this.#errors.inc({ route })
    this.#bytesIn.inc(observation.bytesIn)
    this.#bytesOut.inc(observation.bytesOut)
    this.#duration.observe({ route }, observation.durationMs / 1000)
  }

  recordAuthFailure(routeId: string, reason: AuthFailureReason): void {
    this.#authFailures.inc({ route: this.#route(routeId), reason })
  }

  recordUpstream(routeId: string, durationMs: number): void {
    // The latency of the upstream, and not the latency of the gateway: the
    // two are different numbers and an operator looks at this one when an
    // upstream is slow.
    this.#upstreamDuration.observe({ route: this.#route(routeId) }, durationMs / 1000)
  }

  recordAccess(routeId: string, durationMs: number): void {
    // The latency of the call to the access service, and not the latency of
    // the gateway: the service is a dependency of its own, and an operator
    // looks at this one when the service is slow.
    //
    // Only the calls that reached the service are counted: a decision that
    // came from the cache cost the gateway nothing.
    this.#accessDuration.observe({ route: this.#route(routeId) }, durationMs / 1000)
  }

  recordAccessUnavailable(routeId: string): void {
    // An outage of the access service is not a denial of a caller: it is
    // counted apart, so an operator can tell the two apart.
    this.#accessUnavailable.inc({ route: this.#route(routeId) })
  }

  recordAccessStale(routeId: string, ageMs: number): void {
    // A decision that was served while the service was down is a
    // degradation of the deployment: the traffic went on, and the operator
    // has to see that it went on with an old decision.
    this.#accessStale.inc({ route: this.#route(routeId) })
    this.#accessStaleAge.observe({ route: this.#route(routeId) }, ageMs / 1_000)
  }

  recordWebsocket(routeId: string): void {
    this.#websockets.inc({ route: this.#route(routeId) })
  }

  recordWebsocketRefusal(reason: WebSocketRefusalReason): void {
    this.#websocketRefusals.inc({ reason })
  }

  recordConfigReload(ok: boolean): void {
    this.#configReloads.inc({ result: ok ? 'ok' : 'failed' })
  }

  recordRateLimit(): void {
    // The caller is not a label: an unbounded set of addresses would grow
    // the metrics without limit.
    this.#rateLimited.inc()
  }

  recordCrossSiteRefusal(routeId: string): void {
    this.#crossSiteRefusals.inc({ route: this.#route(routeId) })
  }

  recordSharedStateError(): void {
    this.#sharedStateErrors.inc()
  }

  recordUpstreamFailure(): void {
    this.#upstreamFailures.inc()
  }

  recordUpstreamSkipped(): void {
    this.#upstreamsSkipped.inc()
  }

  async render(): Promise<string> {
    return this.#registry.metrics()
  }

  get contentType(): string {
    return this.#registry.contentType
  }

  /**
   * The label value of a route.
   *
   * The routes beyond the cap are aggregated into a single `overflow`
   * series, so the memory stays bounded. The `unmatched` label is not a
   * route: it is reserved and never counted against the cap.
   */
  #route(routeId: string): string {
    if (routeId === UNMATCHED_ROUTE) return UNMATCHED_ROUTE
    if (this.#routes.has(routeId)) return routeId
    if (this.#routes.size >= MAX_TRACKED_ROUTES) {
      this.#routes.add(OVERFLOW_ROUTE)
      return OVERFLOW_ROUTE
    }
    this.#routes.add(routeId)
    return routeId
  }
}

/** An observer that measures nothing; it is used by the tests. */
export function createSilentObserver(): Observer {
  return {
    requestStarted: () => undefined,
    requestFinished: () => undefined,
    recordRequest: () => undefined,
    recordAuthFailure: () => undefined,
    recordAccessUnavailable: () => undefined,
    recordAccessStale: () => undefined,
    recordAccess: () => undefined,
    recordUpstream: () => undefined,
    recordUpstreamFailure: () => undefined,
    recordUpstreamSkipped: () => undefined,
    recordWebsocket: () => undefined,
    recordWebsocketRefusal: () => undefined,
    recordConfigReload: () => undefined,
    recordRateLimit: () => undefined,
    recordCrossSiteRefusal: () => undefined,
    recordSharedStateError: () => undefined,
    render: async () => '',
    contentType: 'text/plain; version=0.0.4',
  }
}
