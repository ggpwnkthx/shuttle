/**
 * The proxying domain.
 *
 * The domain owns the state of an http exchange: the budgets of the phases,
 * the limit of the body, the cancellation, the moment the answer is
 * committed and the registry of the exchanges that are running.
 */

export { HttpExchangeService, expectsBody } from './exchange'

export type { ExchangeFailure } from './exchange'

export type { HttpTransport, UpstreamRequest, UpstreamResponse } from './transport'

export { UpstreamBreaker } from './breaker'
