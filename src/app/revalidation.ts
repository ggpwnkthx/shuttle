/**
 * The revalidation of an open websocket connection.
 *
 * A connection is authorized when it is opened. A connection that stays
 * open for hours is a connection that was authorized hours ago: the
 * session it was opened with may have expired, the access it was opened
 * with may have been revoked, and the route it was opened on may have
 * changed.
 *
 * The gateway revalidates the connection periodically and closes it when
 * the answer is no. The three things that are checked are the ones the
 * gateway can check without asking anybody:
 *
 * - the **session** still exists: a session that expired ends the
 *   connections it opened;
 * - the **access service** still allows the workspace: a revoked access
 *   ends the connections it allowed;
 * - the **route** still exists and still accepts websockets: a route that
 *   was removed ends the connections it served.
 *
 * The decision of the access service is read through the cache, so a
 * short outage of the service does not close the connections of the
 * deployment. The window of the cache is the latency of a revocation; the
 * interval of the revalidation is added to it.
 */

import type { GatewayDependencies } from './dependencies'

/** What the revalidation needs to know about the connection. */
export interface RevalidationTarget {
  /** The id of the route the connection was opened on. */
  routeId: string
  /** The subject of the caller, when it was authenticated. */
  subject?: string
  /** The roles of the caller. */
  roles?: string[]
  /** The workspace of the connection. */
  workspaceId?: string
  /**
   * The id of the session the connection was opened with.
   *
   * It is absent when the caller authenticated with a bearer token: such a
   * connection is not bound to a session.
   */
  sessionId?: string
}

/**
 * Builds the revalidation of a connection.
 *
 * The callback is called by the websocket domain, which knows nothing about
 * sessions and about the access service.
 */
export function buildRevalidation(
  dependencies: GatewayDependencies,
  target: RevalidationTarget
): () => Promise<{ allowed: boolean; reason?: string }> {
  return async () => {
    // The route. A route that was removed, or that no longer accepts
    // websockets, does not serve the connection any more.
    const snapshot = dependencies.config.snapshot
    const route = snapshot?.routes.find((candidate) => candidate.id === target.routeId)
    if (!snapshot || !route) {
      return { allowed: false, reason: 'the route of the connection does not exist any more' }
    }
    if (!route.payload.websocket) {
      return { allowed: false, reason: 'the route of the connection does not accept websockets' }
    }

    // The session. A session that expired ends the connections it opened.
    if (target.sessionId) {
      let record = null
      try {
        record = await dependencies.auth.sessions.get(target.sessionId)
      } catch {
        // The store cannot be reached: the connection cannot be vouched
        // for, so it is closed. The gateway fails closed everywhere else
        // as well.
        return { allowed: false, reason: 'the session store is not reachable' }
      }
      if (!record) {
        return { allowed: false, reason: 'the session of the connection has expired' }
      }
    }

    // The access service. A revoked access ends the connections it
    // allowed. The decision is asked for again: the cached one is exactly
    // the decision that has to be checked.
    if (target.subject && target.workspaceId) {
      const decision = await dependencies.access.decide(
        {
          subject: target.subject,
          workspaceId: target.workspaceId,
          routeId: target.routeId,
          roles: target.roles,
        },
        { fresh: true }
      )
      if (!decision.allow) {
        return { allowed: false, reason: 'the access to the workspace was revoked' }
      }
    }

    return { allowed: true }
  }
}
