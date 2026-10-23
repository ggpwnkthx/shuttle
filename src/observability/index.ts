/**
 * The observation of the gateway.
 *
 * The observation layer knows nothing about the domains, the application or
 * the runtime: it measures and it writes. The application asks it to record
 * what happened, the runtime gives it the logger and the metrics.
 */

export type { Observer } from './metrics'

export { MetricsStore, UNMATCHED_ROUTE } from './metrics'

export type { Logger } from './logging'

export { createLogger, redactFields, redactUrl } from './logging'
