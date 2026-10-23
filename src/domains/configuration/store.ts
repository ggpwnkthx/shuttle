/**
 * The published configuration of the gateway.
 *
 * A generation is immutable: the routes, the budgets and the trust settings
 * of a request are the ones of the generation the request captured. A reload
 * publishes a new generation, it never changes the one that is running.
 *
 * The publication is atomic: the new configuration is parsed, validated and
 * checked for ambiguity *before* it replaces the running one. A file that is
 * broken on disk never takes a running deployment out of rotation.
 */

import type { CompiledRoute } from '../routing'
import { GATEWAY_RESERVED_PATHS } from './schema'
import { compileTable } from './compile'
import type { EffectiveRoute, EnvironmentDefaults } from './routes'

export type { EffectiveRoute }

/**
 * A published generation of the configuration.
 *
 * The object is frozen: a request that captured it keeps the policy it was
 * answered with, even when a reload happens in the middle of the request.
 */
export interface ConfigurationSnapshot {
  /** The number of the generation, it grows with every publication. */
  revision: number
  /** The moment the generation was published. */
  loadedAt: number
  /** The file the generation was read from. */
  source: string
  /** The paths the gateway reserves for itself. */
  reservedPaths: readonly string[]
  /** The ranges whose forwarding headers are trusted. */
  trustedProxies: readonly string[]
  /** The routes, sorted by the precedence of the matcher. */
  routes: readonly CompiledRoute<EffectiveRoute>[]
}

/** A configuration that could not be published. */
export interface ConfigErrorState {
  message: string
  details: string[]
  at: number
}

/** The outcome of a load. */
export type ReloadResult =
  | { ok: true; revision: number; routes: number }
  | { ok: false; error: ConfigErrorState }

/** The state of the configuration, as the readiness probe reports it. */
export interface ConfigStatus {
  loaded: boolean
  revision: number
  loadedAt: number | null
  source: string
  lastError: ConfigErrorState | null
  routeCount: number
}

export interface ConfigurationStoreOptions {
  /** The file the configuration is read from. */
  source: string
  /**
   * The limit of the body when neither the route nor the defaults set one.
   *
   * It comes from the environment: the configuration file may not know it.
   */
  defaultMaxBodyBytes: number
  /**
   * The budget of one attempt to an upstream when neither the route nor
   * the defaults set one.
   *
   * It comes from the environment.
   */
  defaultUpstreamAttemptMs?: number
  /**
   * The size of a replayable body when neither the route nor the defaults
   * set one.
   *
   * It comes from the environment.
   */
  defaultReplayMaxBytes?: number
  /**
   * The grace of an outage of the access service when neither the route
   * nor the defaults set one.
   *
   * It comes from the environment.
   */
  defaultAccessStaleGraceMs?: number
  /**
   * Called when a generation is published.
   *
   * The runtime uses it to write the policy that is running in the log: a
   * generation is published once at the start and once per reload.
   */
  onPublished?: (snapshot: ConfigurationSnapshot) => void
  /**
   * The ranges of the environment.
   *
   * They are added to the ranges of the file: an operator may configure the
   * ranges of a deployment in the file and the ranges of an installation in
   * the environment.
   */
  trustedProxies?: string[]
}

/**
 * Holds the running configuration.
 *
 * The store owns the last good generation and the last error, they are two
 * different things: a failed reload keeps the last good generation active
 * and reports the error next to it.
 */
export class ConfigurationStore {
  #snapshot: ConfigurationSnapshot | null = null
  #error: ConfigErrorState | null = null
  #revision = 0
  #source: string
  #defaults: EnvironmentDefaults
  #trustedProxies: string[]
  #onPublished?: (snapshot: ConfigurationSnapshot) => void

  constructor(options: ConfigurationStoreOptions) {
    this.#source = options.source
    this.#defaults = {
      defaultMaxBodyBytes: options.defaultMaxBodyBytes,
      defaultUpstreamAttemptMs: options.defaultUpstreamAttemptMs,
      defaultReplayMaxBytes: options.defaultReplayMaxBytes,
      defaultAccessStaleGraceMs: options.defaultAccessStaleGraceMs,
    }
    this.#trustedProxies = options.trustedProxies ?? []
    this.#onPublished = options.onPublished
  }

  /** The running generation, or null when there never was one. */
  get snapshot(): ConfigurationSnapshot | null {
    return this.#snapshot
  }

  /** True when a configuration was published at least once. */
  get loaded(): boolean {
    return this.#snapshot !== null
  }

  /** The last error, or null when the last load was a success. */
  get lastError(): ConfigErrorState | null {
    return this.#error
  }

  /** The number of the running generation. */
  get revision(): number {
    return this.#revision
  }

  /** The file the configuration is read from. */
  get source(): string {
    return this.#source
  }

  /**
   * Validates a raw configuration and publishes it when it is valid.
   *
   * The publication happens at the very end: a configuration that is not
   * valid leaves the running one untouched.
   */
  apply(raw: unknown): ReloadResult {
    const result = compileTable(raw, this.#defaults, this.#trustedProxies)
    if (!result.ok) {
      const details = [...result.errors, ...result.conflicts]
      this.#error = {
        message: `invalid configuration: ${details.join('; ')}`,
        details,
        at: Date.now(),
      }
      return { ok: false, error: this.#error }
    }
    const { table } = result
    this.#revision += 1
    this.#snapshot = Object.freeze({
      revision: this.#revision,
      loadedAt: Date.now(),
      source: this.#source,
      reservedPaths: Object.freeze([...table.reservedPaths]),
      trustedProxies: Object.freeze([...table.trustedProxies]),
      routes: Object.freeze(table.routes),
    })
    this.#error = null
    // The policy that is running is published: the runtime writes it in
    // the log, so an operator sees what the gateway does.
    this.#onPublished?.(this.#snapshot)
    return { ok: true, revision: this.#revision, routes: table.routes.length }
  }

  /**
   * Validates the text of a configuration file and publishes it.
   *
   * A file that is not json is a configuration error like any other: it is
   * recorded next to the last good generation, so the readiness probe can
   * report it.
   */
  applyText(raw: string): ReloadResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const state: ConfigErrorState = {
        message: `the configuration file is not valid json: ${
          error instanceof Error ? error.message : String(error)
        }`,
        details: [],
        at: Date.now(),
      }
      this.#error = state
      return { ok: false, error: state }
    }
    return this.apply(parsed)
  }

  /**
   * Records a failure that happened outside of the store.
   *
   * The source of the table may be the shared state (§3.4): a store that
   * cannot be reached is a failure of the load, and it is recorded next to
   * the last good generation, so the readiness probe reports it.
   */
  fail(message: string, details: string[] = []): ConfigErrorState {
    const state: ConfigErrorState = { message, details, at: Date.now() }
    this.#error = state
    return state
  }

  /** The state of the configuration, as the readiness probe reports it. */
  status(): ConfigStatus {
    return {
      loaded: this.#snapshot !== null,
      revision: this.#revision,
      loadedAt: this.#snapshot?.loadedAt ?? null,
      source: this.#source,
      lastError: this.#error,
      routeCount: this.#snapshot?.routes.length ?? 0,
    }
  }
}

/**

/**
 * Reports whether a path is reserved for the gateway.
 *
 * The paths the gateway serves itself are always reserved, the additional
 * paths of the configuration are reserved on top of them. A reserved path is
 * never routed to an upstream, not even in the spelling with a trailing
 * slash: the gateway owns the name.
 */
export function isReservedPath(snapshot: ConfigurationSnapshot, path: string): boolean {
  const normalized = path.replace(/\/+$/, '') || '/'
  const reserved = [...GATEWAY_RESERVED_PATHS, ...snapshot.reservedPaths]
  return reserved.some((candidate) => (candidate.replace(/\/+$/, '') || '/') === normalized)
}
