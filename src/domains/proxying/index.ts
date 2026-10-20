/**
 * The proxying domain.
 *
 * The domain owns the state of an http exchange: the budgets of the phases,
 * the limit of the body, the cancellation and the moment the answer is
 * committed to the caller.
 */

export type { HttpTransport, UpstreamRequest, UpstreamResponse } from './transport'
