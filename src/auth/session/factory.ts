import { MemorySessionStore } from './memory'
import { RedisSessionStore } from './redis'
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  type SessionStore,
} from './types'
import type { Logger } from '../../log/logger'

export interface SessionConfig {
  /** Connection URL, for example `memory://local` or `rediss://host:6379/0`. */
  url: string
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
  ttlMs?: number
  touchIntervalMs?: number
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** Maximum number of sessions of the in-process store. */
  maxSessions?: number
  logger?: Logger
}

export const SUPPORTED_SESSION_SCHEMES = ['memory:', 'redis:', 'rediss:'] as const

/**
 * Builds the session store described by the configuration.
 *
 * The store is selected by the scheme of the URL, so an infrastructure
 * module only has to hand the application a single value and never has to
 * mention a cloud provider.
 *
 * There is exactly one behaviour when the store cannot be reached: the
 * request is denied. A gateway that mirrors the sessions in its own memory
 * would authenticate a caller that no other replica knows.
 */
export function createSessionStore(config: SessionConfig): SessionStore {
  const url = parseSessionUrl(config.url)
  const common = {
    ttlMs: config.ttlMs ?? DEFAULT_SESSION_TTL_MS,
    touchIntervalMs: config.touchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  }
  switch (url.protocol) {
    case 'memory:':
      return new MemorySessionStore({
        ...common,
        maxSessions: config.maxSessions ?? DEFAULT_MAX_SESSIONS,
      })
    case 'redis:':
    case 'rediss:':
      return new RedisSessionStore({
        ...common,
        url: config.url,
        keyPrefix: config.keyPrefix ?? 'shuttle',
        tlsCa: config.tlsCa,
        logger: config.logger,
      })
    default:
      throw new Error(
        `unsupported session store "${url.protocol}" (supported: ${SUPPORTED_SESSION_SCHEMES.join(', ')})`
      )
  }
}

function parseSessionUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error(`the session store url "${value}" is not a valid url`)
  }
}
