import chokidar, { type FSWatcher } from 'chokidar'
import { readFile, stat } from 'node:fs/promises'
import {
  ConfigValidationError,
  parseConfig,
  type ShuttleConfig,
} from './schema'
import { compileRoutes, detectConflicts, sortRoutes, type CompiledRoute } from './matcher'

export interface ConfigState {
  config: ShuttleConfig
  routes: CompiledRoute[]
  revision: number
  loadedAt: number
  source: string
}

export interface ConfigErrorState {
  message: string
  details: string[]
  at: number
}

export type ReloadResult =
  | { ok: true; revision: number; routes: number }
  | { ok: false; error: ConfigErrorState }

/**
 * Holds the active configuration.
 *
 * Reloads are atomic: a new configuration is fully parsed, validated and
 * checked for ambiguity *before* it replaces the running one. If anything is
 * wrong the previous configuration stays active and the failure is recorded so
 * it can be surfaced on the dashboard.
 */
export class ConfigStore {
  #state: ConfigState | null = null
  #error: ConfigErrorState | null = null
  #lastAttemptAt = 0
  #revision = 0
  #source: string
  #watcher: FSWatcher | null = null
  #listeners = new Set<(result: ReloadResult) => void>()
  /** `mtime:size` of the file that is currently active. */
  #signature: string | null = null

  constructor(source: string) {
    this.#source = source
  }

  get source(): string {
    return this.#source
  }

  get loaded(): boolean {
    return this.#state !== null
  }

  get revision(): number {
    return this.#revision
  }

  get lastError(): ConfigErrorState | null {
    return this.#error
  }

  get state(): ConfigState {
    if (!this.#state) {
      throw new Error('configuration has not been loaded yet')
    }
    return this.#state
  }

  /** Registers a listener that is called after every (successful or failed) reload. */
  onReload(listener: (result: ReloadResult) => void): void {
    this.#listeners.add(listener)
  }

  /** Validates the given raw value and activates it if it is fully valid. */
  apply(raw: unknown, signature: string | null = null): ReloadResult {
    this.#lastAttemptAt = Date.now()
    try {
      const config = parseConfig(raw)
      const routes = sortRoutes(compileRoutes(config))
      const conflicts = detectConflicts(routes, config.reservedPaths)
      if (conflicts.length > 0) {
        throw new ConfigValidationError(conflicts)
      }
      this.#revision += 1
      this.#state = {
        config,
        routes,
        revision: this.#revision,
        loadedAt: Date.now(),
        source: this.#source,
      }
      this.#signature = signature
      this.#error = null
      const result: ReloadResult = { ok: true, revision: this.#revision, routes: routes.length }
      this.#notify(result)
      return result
    } catch (error) {
      const errorState: ConfigErrorState = {
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof ConfigValidationError ? error.details : [],
        at: Date.now(),
      }
      this.#error = errorState
      const result: ReloadResult = { ok: false, error: errorState }
      this.#notify(result)
      return result
    }
  }

  /** Reads the configuration file and activates it when it is valid. */
  async reload(): Promise<ReloadResult> {
    // Ignore reloads when the file did not actually change.
    const info = await stat(this.#source).catch(() => undefined)
    if (info) {
      const signature = `${info.mtimeMs}:${info.size}`
      if (signature === this.#signature && this.#state) {
        return { ok: true, revision: this.#revision, routes: this.#state.routes.length }
      }
    }

    let raw: string
    try {
      raw = await readFile(this.#source, 'utf8')
    } catch (error) {
      this.#lastAttemptAt = Date.now()
      const errorState: ConfigErrorState = {
        message: `unable to read configuration file: ${error instanceof Error ? error.message : String(error)}`,
        details: [],
        at: Date.now(),
      }
      this.#error = errorState
      const result: ReloadResult = { ok: false, error: errorState }
      this.#notify(result)
      return result
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#lastAttemptAt = Date.now()
      const errorState: ConfigErrorState = {
        message: `configuration file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        details: [],
        at: Date.now(),
      }
      this.#error = errorState
      const result: ReloadResult = { ok: false, error: errorState }
      this.#notify(result)
      return result
    }
    return this.apply(parsed, info ? `${info.mtimeMs}:${info.size}` : null)
  }

  #notify(result: ReloadResult): void {
    for (const listener of this.#listeners) {
      try {
        listener(result)
      } catch {
        /* a broken listener must not break the reload */
      }
    }
  }

  status(): {
    loaded: boolean
    revision: number
    loadedAt: number | null
    source: string
    lastAttemptAt: number
    lastError: ConfigErrorState | null
    routeCount: number
  } {
    return {
      loaded: this.loaded,
      revision: this.#revision,
      loadedAt: this.#state?.loadedAt ?? null,
      source: this.#source,
      lastAttemptAt: this.#lastAttemptAt,
      lastError: this.#error,
      routeCount: this.#state?.routes.length ?? 0,
    }
  }

  /**
   * Watches the configuration file and reloads it when it changes.
   *
   * The watcher follows the file itself, so an editor that replaces the
   * file instead of writing it is noticed as well.
   */
  watchForChanges(debounceMs = 250): void {
    if (this.#watcher) return
    try {
      this.#watcher = chokidar.watch(this.#source, { ignoreInitial: false })
      this.#watcher.on('all', (event) => {
        if (event !== 'change' && event !== 'add') return
        const timer = setTimeout(() => {
          void this.reload()
        }, debounceMs)
        timer.unref?.()
      })
    } catch {
      this.#watcher = null
    }
  }

  close(): void {
    void this.#watcher?.close()
    this.#watcher = null
  }
}
