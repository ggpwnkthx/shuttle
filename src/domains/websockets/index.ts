/**
 * The websocket domain.
 *
 * The domain owns the reservation of a slot, the order of the handshake (the
 * upstream first, the caller second) and the bridge between the two legs.
 */

export type {
  ClientLeg,
  ClientUpgradePort,
  UpstreamHandshakeOutcome,
  UpstreamHandshakePort,
  UpstreamHandshakeRequest,
  UpstreamSocket,
  UpstreamSocketEvents,
  WebSocketMessage,
} from './ports'
