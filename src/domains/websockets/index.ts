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
  UpstreamHandshakeOutcome,
  UpstreamHandshakePort,
  UpstreamHandshakeRequest,
  UpstreamSocket,
  UpstreamSocketEvents,
  WebSocketMessage,
} from './ports'

export type { WebSocketUpgradeContext } from './context'

export { ReservationManager } from './reservation'

export {
  CLOSE_GOING_AWAY,
  CLOSE_TRY_AGAIN_LATER,
  WebSocketBridge,
  periodOf,
  truncateCloseReason,
} from './bridge'

export { WebSocketService, offeredProtocols } from './service'
export type { WebSocketServicePort } from './service'
