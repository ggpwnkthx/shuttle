/**
 * The log of the policy that is running.
 *
 * The route table and the environment decide what the gateway does, and
 * both are large: an operator that has to read the two to know that a
 * route is open to unauthenticated callers is an operator that will not
 * notice. The gateway writes the policy it is running in its log, once per
 * generation, so the answer is one search away.
 *
 * The permissive settings are written as warnings: they are not errors and
 * a deployment may want them, but nobody should discover them from an
 * incident.
 */

import { describeConfiguration, type ConfigurationSnapshot } from '../domains/configuration'
import { redactUrl, type Logger } from '../observability'

/**
 * Writes the configuration that is running in the log.
 *
 * One line for the configuration, one line for every route and one warning
 * for every setting that is permissive.
 */
export function logActiveConfiguration(logger: Logger, snapshot: ConfigurationSnapshot): void {
  const description = describeConfiguration(snapshot)

  logger.info('the configuration is active', {
    revision: description.revision,
    source: description.source,
    routes: description.routeCount,
  })

  for (const route of description.routes) {
    logger.info('the route is active', {
      routeId: route.id,
      host: route.host,
      path: route.path,
      methods: route.methods,
      rewrite: route.rewrite,
      upstreams: route.upstreams.map((upstream) => redactUrl(upstream)),
      auth: route.auth,
      workspace: route.workspace,
      requireUuid: route.workspace ? route.requireUuid : null,
      crossSite: route.crossSite,
      forwardAuthorization: route.forwardAuthorization,
      websocket: route.websocket,
      maxBodyBytes: route.maxBodyBytes,
      responseMs: route.timeouts.responseMs,
      firstByteMs: route.timeouts.firstByteMs,
      bodyMs: route.timeouts.bodyMs,
      accessCacheTtlMs: route.accessCacheTtlMs,
    })
  }

  for (const warning of description.warnings) {
    logger.warn('the setting is permissive', {
      routeId: warning.routeId,
      code: warning.code,
      message: warning.message,
    })
  }
}
