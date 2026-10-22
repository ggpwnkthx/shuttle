/**
 * The websocket domain.
 *
 * The domain owns the reservation of a slot, the order of the handshake (the
 * upstream first, the caller second) and the bridge between the two legs.
 */

export type {
  ClientEventHandlers,
  ClientLeg,
  ClientUpgradePort,
  ClientUpgradeResult,
  RevalidationOutcome,
  RevalidationPort,
  UpstreamHandshakeOutcome,
  UpstreamHandshakePort,
  UpstreamHandshakeRequest,
  UpstreamSocket,
  UpstreamSocketEvents,
  WebSocketMessage,
} from './ports'

export type { WebSocketUpgradeContext } from './context'

export { ReservationManager } from './reservation'
export type { ReservationOptions } from './reservation'

export {
  CLOSE_GOING_AWAY,
  CLOSE_NORMAL,
  CLOSE_POLICY_VIOLATION,
  CLOSE_TRY_AGAIN_LATER,
  MAX_CLOSE_REASON_BYTES,
  REVALIDATION_JITTER,
  WebSocketBridge,
  periodOf,
  truncateCloseReason,
} from './bridge'
export type { BridgeOptions } from './bridge'

export { WebSocketService, offeredProtocols } from './service'
export type {
  WebSocketOutcome,
  WebSocketServiceOptions,
  WebSocketServicePort,
  WebSocketSettings,
} from './service'
