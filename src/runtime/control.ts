/**
 * The composition root of the control plane.
 *
 * The control plane is a separate process: it has its own listener, its
 * own tokens and its own credentials on the shared state. This module is
 * the only place where the pieces are assembled: the state the control
 * plane acts on is opened here, the stores are built here and the
 * application is wired here.
 *
 * The gateway never routes a request to the control plane and the control
 * plane never goes through the gateway: they meet in the shared state.
 */

import { readFile } from 'node:fs/promises'
import { createControlApp, createControlHandler } from '../app/control'
import {
  ControlService,
  parseControlTokens,
  parseProtectedRoutes,
  type AuthFailureCounter,
} from '../domains/control'
import { PostgresAuthFailureCounter, RedisAuthFailureCounter } from '../domains/control/adapters'
import type { RouteTableStore } from '../domains/configuration'
import { PostgresRouteTableStore, RedisRouteTableStore } from '../domains/configuration/adapters'
import { PostgresSessionStore, RedisSessionStore } from '../domains/authentication/adapters'
import type { SessionStore } from '../domains/authentication'
import { PostgresDecisionCache, RedisDecisionCache } from '../domains/workspace-access/adapters'
import type { DecisionCache } from '../domains/workspace-access'
import { createLogger, type Logger } from '../observability'
import { startListener, type StartedListener } from '../platform/bun/listener'
import { connectSharedState } from './composition'
import type { ControlSettings } from './env'
import { VERSION } from './version'

/** The runtime of the control plane. */
export interface ControlRuntime {
  /** The settings the runtime was built with. */
  settings: ControlSettings
  /** The logger of the control plane. */
  logger: Logger
  /** The service of the control plane. */
  service: ControlService
  /** The listener of the control plane. */
  listener: StartedListener
  /** True while the control plane is draining. */
  isDraining: () => boolean
  /** Drains the control plane and closes everything it owns. */
  drain: (reason: string) => Promise<void>
  /** Closes everything the runtime owns. */
  close: () => Promise<void>
}

/** The options of the runtime of the control plane. */
export interface ControlRuntimeOptions {
  /** The sink of the lines of the log; overridable for the tests. */
  logSink?: (line: string) => void
}

/**
 * Reads the map of the tokens.
 *
 * The map is in the environment or in a file: the file is the usual case,
 * because the map holds the credentials of the deployment.
 */
async function readTokens(settings: ControlSettings): Promise<string> {
  if (settings.tokens) return settings.tokens
  if (!settings.tokensFile) {
    throw new Error('the control plane has no token map')
  }
  try {
    return await readFile(settings.tokensFile, 'utf8')
  } catch (error) {
    throw new Error(
      `the map of the tokens of the control plane could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/**
 * Refuses a token that is the secret of something else.
 *
 * A credential that is used twice is used twice: a token of the control
 * plane that is also the password of the shared state is a password that
 * an operator of the deployment has to rotate in two places, and a token
 * that leaks gives the holder the shared state as well.
 */
function refuseSecrets(tokens: ReadonlyMap<string, unknown>, stateUrl: string): void {
  const secrets = new Set<string>()
  try {
    const parsed = new URL(stateUrl)
    if (parsed.password) secrets.add(parsed.password)
    if (parsed.username) secrets.add(parsed.username)
  } catch {
    // The url is validated by the environment: a url that cannot be read
    // has no secret to compare with.
  }
  for (const [token] of tokens) {
    if (secrets.has(token)) {
      throw new Error(
        'a token of the control plane is the secret of the shared state: a credential that is used twice is used twice'
      )
    }
  }
}

/**
 * Builds the runtime of the control plane.
 *
 * A map of tokens that cannot be read stops the process: a control plane
 * that starts with a map it does not understand is a control plane that
 * nobody controls.
 */
export async function createControlRuntime(
  settings: ControlSettings,
  options: ControlRuntimeOptions = {}
): Promise<ControlRuntime> {
  const logger = createLogger({
    level: 'info',
    bindings: { service: 'shuttle-control' },
    write: options.logSink,
  })

  const tokens = parseControlTokens(await readTokens(settings))
  refuseSecrets(tokens, settings.stateUrl)

  const onStateError = (error: unknown): void => {
    logger.warn('the shared state of the control plane is not reachable', { error })
  }

  const connection = await connectSharedState({
    url: settings.stateUrl,
    tlsCa: settings.stateTlsCa,
    postgres: settings.postgres,
    onError: onStateError,
  })
  if (!connection) {
    throw new Error(
      'the control plane acts on the shared state: SHUTTLE_CONTROL_STATE_URL has to name a Redis or a Postgres server'
    )
  }

  // The key of the audit trail of the state. Every write of the control
  // plane writes it, and every write of it is in the same transaction as
  // the change it records.
  const auditKey = `${settings.keyPrefix}:audit`

  const routeTable: RouteTableStore =
    connection.kind === 'redis'
      ? new RedisRouteTableStore({
          client: connection.client,
          keyPrefix: settings.keyPrefix,
          auditKey,
        })
      : new PostgresRouteTableStore({ client: connection.client })

  const sessions: SessionStore =
    connection.kind === 'redis'
      ? new RedisSessionStore({
          client: connection.client,
          keyPrefix: settings.keyPrefix,
          auditKey,
        })
      : new PostgresSessionStore({
          client: connection.client,
          keyPrefix: settings.keyPrefix,
        })

  const decisions: DecisionCache =
    connection.kind === 'redis'
      ? new RedisDecisionCache({
          client: connection.client,
          keyPrefix: settings.sharedStateKeyPrefix,
          auditKey,
        })
      : new PostgresDecisionCache({
          client: connection.client,
          keyPrefix: settings.sharedStateKeyPrefix,
        })

  const failures: AuthFailureCounter =
    connection.kind === 'redis'
      ? new RedisAuthFailureCounter({
          client: connection.client,
          keyPrefix: settings.keyPrefix,
        })
      : new PostgresAuthFailureCounter({ client: connection.client })

  const service = new ControlService({
    routeTable,
    sessions,
    decisions,
    failures,
    tokens,
    protectedRoutes: parseProtectedRoutes(settings.protectedRoutes.join(',')),
    defaults: settings.defaults,
    trustedProxies: settings.trustedProxies,
    trustedProxiesConfigured: settings.trustedProxiesConfigured,
  })

  const state = { draining: false }
  const peer = { address: (_request: Request) => '0.0.0.0' }

  const app = createControlApp({
    service,
    logger,
    version: VERSION,
    peerAddress: (request) => peer.address(request),
    isDraining: () => state.draining,
  })
  const listener = startListener({
    app: createControlHandler(app),
    host: settings.host,
    port: settings.port,
    onError: (error) => logger.error('the listener reported an error', { error }),
  })
  peer.address = listener.peerAddress

  const closeResources = async (): Promise<void> => {
    await connection.client.close()
  }

  return {
    settings,
    logger,
    service,
    listener,
    isDraining: () => state.draining,
    drain: async (reason: string) => {
      state.draining = true
      logger.info('the control plane is draining', { reason })
      await listener.stop(false).catch(() => undefined)
      await closeResources()
      logger.info('the control plane is stopped')
    },
    close: closeResources,
  }
}
