/**
 * The lifecycle of the gateway.
 *
 * The runtime owns the admission and the shutdown: it watches the
 * configuration file, it handles the signals of the process and it drains
 * the work that is in flight before the process exits.
 */

import { readFile } from 'node:fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Logger, Observer } from '../observability'
import type {
  ConfigurationStore,
  RouteTablePointer,
  RouteTableRevision,
  RouteTableStore,
} from '../domains/configuration'

export interface WatchOptions {
  /** The running configuration. */
  store: ConfigurationStore
  /** The logger of the gateway. */
  logger: Logger
  /** The observer of the gateway. */
  observer: Observer
  /** The file the configuration is read from. */
  path: string
  /** How long a burst of changes is waited out, in milliseconds. */
  debounceMs?: number
}

/**
 * The watcher of the configuration file.
 */
export interface ConfigurationWatcher {
  /** Resolves when the watcher is ready: the changes before that are missed. */
  ready: Promise<void>
  /** Stops the watcher. */
  stop: () => void
}

/**
 * Watches the configuration file.
 *
 * The watcher follows the file itself, so an editor that replaces the file
 * instead of writing it is noticed as well. The loads are serialized: an
 * older read that arrives late must not overwrite a newer generation.
 */
export function watchConfiguration(options: WatchOptions): ConfigurationWatcher {
  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()
  let closed = false

  const load = (): void => {
    if (closed) return
    queue = queue.then(async () => {
      if (closed) return
      let raw: string
      try {
        raw = await readFile(options.path, 'utf8')
      } catch (error) {
        options.logger.error('the configuration file could not be read', { error })
        options.observer.recordConfigReload(false)
        return
      }
      const result = options.store.applyText(raw)
      if (!result.ok) {
        // The last good configuration stays active: a file that is broken
        // on disk must not take a running deployment out of rotation.
        options.logger.error('the configuration reload failed, the previous one stays active', {
          error: result.error,
        })
        options.observer.recordConfigReload(false)
        return
      }
      options.logger.info('the configuration was reloaded', {
        revision: result.revision,
        routes: result.routes,
      })
      // The policy of the new generation is written in the log by the
      // store, when it publishes it: a reload may change what a route
      // accepts.
      options.observer.recordConfigReload(true)
    })
  }

  let watcher: FSWatcher | null = null
  let markReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  try {
    watcher = chokidar.watch(options.path, { ignoreInitial: true })
    watcher.on('ready', () => markReady())
    watcher.on('all', (event) => {
      if (event !== 'change' && event !== 'add' && event !== 'unlink') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, debounceMs)
      timer.unref?.()
    })
  } catch (error) {
    options.logger.error('the configuration file could not be watched', { error })
    watcher = null
  }

  return {
    ready,
    stop: () => {
      closed = true
      if (timer) clearTimeout(timer)
      void watcher?.close()
    },
  }
}

export interface DrainOptions {
  /** The logger of the gateway. */
  logger: Logger
  /** How long the drain may take, in milliseconds. */
  timeoutMs: number
  /** Stops the listener; `force` closes the connections that are open. */
  stopListener: (force: boolean) => Promise<void>
  /** Stops the websockets that are open. */
  closeWebsockets?: () => number
  /** Stops the exchanges that are running. */
  abortExchanges?: () => number
  /** Closes the clients and the stores. */
  closeResources: () => Promise<void>
  /** Reports whether the gateway is draining. */
  setDraining: (draining: boolean) => void
}

/**
 * Drains the gateway.
 *
 * The admission stops first: a task that is going away does not accept new
 * work. The connections that are open get the deadline, then they are
 * closed.
 */
export async function drain(options: DrainOptions, reason: string): Promise<void> {
  options.logger.info('the gateway is draining', { reason })
  options.setDraining(true)

  const closed = options.closeWebsockets?.() ?? 0
  if (closed > 0) {
    options.logger.info('the open websockets were closed', { connections: closed })
  }

  const drained = await Promise.race([
    options.stopListener(false).then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), options.timeoutMs)
      timer.unref?.()
    }),
  ])
  if (!drained) {
    options.logger.warn('the drain deadline was reached, the remaining connections are closed', {
      timeoutMs: options.timeoutMs,
    })
    // The work that is left is cancelled: a process that exits does not
    // leave an upstream working.
    const aborted = options.abortExchanges?.() ?? 0
    if (aborted > 0) {
      options.logger.warn('the exchanges that were running were cancelled', { exchanges: aborted })
    }
    await options.stopListener(true).catch(() => undefined)
  }

  await options.closeResources()
  options.logger.info('the gateway is stopped')
}

/** The options of the watcher of the route table of the shared state. */
export interface RouteTableWatcherOptions {
  /** The running configuration. */
  store: ConfigurationStore
  /** The store of the route table in the shared state. */
  routeTable: RouteTableStore
  /** The logger of the gateway. */
  logger: Logger
  /** The observer of the gateway. */
  observer: Observer
  /** The id of the replica, the one of its heartbeat. */
  replicaId: string
  /** How often the pointer is read, in milliseconds. */
  pollIntervalMs?: number
  /** How often the heartbeat is written, in milliseconds. */
  heartbeatIntervalMs?: number
  /** How long a heartbeat lives, in milliseconds. */
  heartbeatLifetimeMs?: number
}

/** The watcher of the route table of the shared state. */
export interface RouteTableWatcher {
  /** The revision the watcher applied, or null when it applied none. */
  revision: () => number | null
  /** Stops the watcher. */
  stop: () => void
}

/** How often the pointer of the active revision is read. */
export const ROUTE_TABLE_POLL_INTERVAL_MS = 500

/** How often the heartbeat of the replica is written. */
export const HEARTBEAT_INTERVAL_MS = 5_000

/** How long the heartbeat of a replica lives. */
export const HEARTBEAT_LIFETIME_MS = 30_000

/**
 * Watches the pointer of the active revision of the route table.
 *
 * The pointer is read at least once a second, and every revision it names
 * goes through the **same path as the file**: the whole table is validated
 * and checked for ambiguity before it replaces the running one, so a broken
 * table never takes a running deployment out of rotation.
 *
 * A store that cannot be reached keeps the last valid table: the
 * deployment goes on serving the table it has, and the failure is reported
 * like a failed reload of the file.
 *
 * The replica writes a heartbeat with a time to live, so the control plane
 * shows the replicas that are really there.
 */
export function watchRouteTable(options: RouteTableWatcherOptions): RouteTableWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? ROUTE_TABLE_POLL_INTERVAL_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const heartbeatLifetimeMs = options.heartbeatLifetimeMs ?? HEARTBEAT_LIFETIME_MS
  let applied: number | null = null
  let closed = false

  const apply = async (): Promise<void> => {
    if (closed) return
    let pointer: RouteTablePointer | null
    try {
      pointer = await options.routeTable.activePointer()
    } catch (error) {
      // The store is not reachable: the last valid table stays active and
      // the failure is reported.
      options.logger.warn('the route table of the shared state is not reachable', { error })
      options.store.fail('the route table of the shared state is not reachable')
      options.observer.recordConfigReload(false)
      return
    }
    if (!pointer) {
      // An empty store: the file of the deployment is the table, and the
      // watcher waits for a revision.
      return
    }
    if (pointer.revision === applied) return
    let revision: RouteTableRevision | null
    try {
      revision = await options.routeTable.readRevision(pointer.revision)
    } catch (error) {
      options.logger.warn('the route table of the shared state is not reachable', { error })
      options.store.fail('the route table of the shared state is not reachable')
      options.observer.recordConfigReload(false)
      return
    }
    if (!revision) {
      options.logger.error('the revision of the route table does not exist', {
        revision: pointer.revision,
      })
      options.store.fail(`the revision ${pointer.revision} of the route table does not exist`)
      options.observer.recordConfigReload(false)
      return
    }
    const result = options.store.apply(revision.table)
    if (!result.ok) {
      // The table of the revision is not valid: the last good table stays
      // active and the error is reported.
      options.logger.error('the route table of the shared state is not valid', {
        revision: revision.revision,
        error: result.error,
      })
      options.observer.recordConfigReload(false)
      return
    }
    applied = revision.revision
    options.logger.info('the route table of the shared state was applied', {
      revision: revision.revision,
      routes: result.routes,
      author: revision.author,
    })
    options.observer.recordConfigReload(true)
  }

  const beat = async (): Promise<void> => {
    if (closed) return
    try {
      await options.routeTable.writeHeartbeat(
        {
          replicaId: options.replicaId,
          revision: applied,
          lastError: options.store.lastError?.message ?? null,
          at: Date.now(),
        },
        heartbeatLifetimeMs
      )
    } catch (error) {
      options.logger.warn('the heartbeat of the replica could not be written', { error })
    }
  }

  const poll = setInterval(() => {
    void apply()
  }, pollIntervalMs)
  poll.unref?.()
  const heartbeat = setInterval(() => {
    void beat()
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  return {
    revision: () => applied,
    stop: () => {
      closed = true
      clearInterval(poll)
      clearInterval(heartbeat)
    },
  }
}

/** The options of the first load of the route table. */
export interface InitialLoadOptions {
  /** The running configuration. */
  store: ConfigurationStore
  /** The file of the route table, the fallback of an empty store. */
  path: string
  /** The store of the route table in the shared state, when there is one. */
  routeTable?: RouteTableStore
  /** The logger of the gateway. */
  logger: Logger
  /** The observer of the gateway. */
  observer: Observer
}

/**
 * Loads the route table of the deployment.
 *
 * The source of the table is the shared state when the deployment asks for
 * it (§3.4 of the specification), and the file otherwise. A store that is
 * empty, or that cannot be reached, falls back to the file: a deployment
 * without a table has no route to offer.
 *
 * It returns true when a table was published.
 */
export async function loadInitialConfiguration(options: InitialLoadOptions): Promise<boolean> {
  if (options.routeTable) {
    try {
      const pointer = await options.routeTable.activePointer()
      if (pointer) {
        const revision = await options.routeTable.readRevision(pointer.revision)
        if (revision) {
          const result = options.store.apply(revision.table)
          if (result.ok) {
            options.logger.info('the route table of the shared state was loaded', {
              revision: revision.revision,
              routes: result.routes,
              author: revision.author,
            })
            options.observer.recordConfigReload(true)
            return true
          }
          options.logger.error('the route table of the shared state is not valid', {
            error: result.error,
          })
          options.observer.recordConfigReload(false)
        }
      }
    } catch (error) {
      options.logger.warn('the route table of the shared state is not reachable', { error })
    }
  }
  return await loadConfigurationFile(options)
}

/**
 * Reads the file of the route table and publishes it.
 *
 * It returns false when the file is not valid: the gateway has no route to
 * offer and it does not start.
 */
export async function loadConfigurationFile(options: InitialLoadOptions): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(options.path, 'utf8')
  } catch (error) {
    options.logger.error('the configuration file could not be read', { error })
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    options.logger.error('the configuration file is not valid json', { error })
    return false
  }
  const loaded = options.store.apply(parsed)
  if (!loaded.ok) {
    options.logger.error('the initial configuration is invalid', { error: loaded.error })
    return false
  }
  options.logger.info('the configuration was loaded', {
    revision: loaded.revision,
    routes: loaded.routes,
    source: options.store.source,
  })
  // The policy that is running is written in the log by the store, when it
  // publishes the generation.
  options.observer.recordConfigReload(true)
  return true
}
