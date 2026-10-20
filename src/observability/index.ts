/**
 * The observation of the gateway.
 *
 * The observation layer knows nothing about the domains, the application or
 * the runtime: it measures and it writes. The application asks it to record
 * what happened, the runtime gives it the logger and the metrics.
 */

export type {
  AuthFailureReason,
  Observer,
  RequestObservation,
  WebSocketRefusalReason,
} from './metrics'
export { MetricsStore, UNMATCHED_ROUTE, createSilentObserver } from './metrics'

export type { LogFields, LogLevel, Logger } from './logging'
export { createLogger, createSilentLogger, parseLogLevel, redactFields, redactUrl } from './logging'
