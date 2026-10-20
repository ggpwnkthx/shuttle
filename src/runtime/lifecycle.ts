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
import type { ConfigurationStore } from '../domains/configuration'

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
