/**
 * The state of a request of the gateway.
 *
 * The state travels with the request: the identifier of the request, the
 * generation of the configuration it captured and the cookies that have to
 * be written into its answer.
 */

import type { GatewayCookie } from '../domains/authentication'
import type { ConfigurationSnapshot } from '../domains/configuration'
import type { ForwardingContext } from '../domains/forwarding'
import type { ClientUpgradePort } from '../domains/websockets'

/** The state of a request. */
export interface GatewayState {
  /** The identifier of the request; it is in every log line of the request. */
  requestId: string
  /** The moment the request arrived, in milliseconds. */
  startedAt: number
  /**
   * The generation of the configuration the request captured.
   *
   * The generation is captured once and it is never replaced: a reload in
   * the middle of a request does not change the policy of that request.
   */
  snapshot: ConfigurationSnapshot | null
  /** The forwarding context of the request. */
  forwarding: ForwardingContext | null
  /** The cookies that have to be written into the answer of the request. */
  cookies: GatewayCookie[]
}

/**
 * The environment of the application.
 *
 * The bindings are the capabilities of the runtime: the upgrade of a
 * websocket connection, which the platform builds for every request.
 */
export interface GatewayEnv {
  Bindings: {
    /** The upgrade of a websocket connection, when the deployment has one. */
    upgrade?: ClientUpgradePort
  }
  Variables: GatewayState
}
