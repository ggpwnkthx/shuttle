/**
 * The logs of the gateway.
 *
 * The format is JSON and the redaction happens before anything is written:
 * a credential never reaches the log stream. The library owns the format,
 * the levels and the destination; this module decides what is logged and
 * what is redacted.
 */

import pino from 'pino'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const REDACTED = '[redacted]'

/** The placeholder origin used to parse a path with a query string. */
const REDACTION_BASE = 'http://redaction.invalid'

/** Headers whose values must never be logged verbatim. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-shuttle-session',
  'x-shuttle-token',
  'x-amz-security-token',
])

/** Query parameters whose values must never be logged verbatim. */
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'code',
  'code_verifier',
  'id_token',
  'refresh_token',
  'state',
  'token',
])

export type LogFields = Record<string, unknown>

export interface Logger {
  readonly level: LogLevel
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/** Reports whether a header carries a credential. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase())
}

/**
 * Redacts the sensitive query parameters of an url-ish string.
 *
 * The value may be an absolute url or a path with a query string. A path is
 * resolved against a placeholder origin, because a relative path is not a
 * valid url and would otherwise be returned unchanged.
 */
export function redactUrl(rawUrl: string): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl)
  let url: URL
  try {
    url = new URL(rawUrl, isAbsolute ? undefined : REDACTION_BASE)
  } catch {
    return rawUrl
  }
  let changed = false
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED)
      changed = true
    }
  }
  if (!changed) return rawUrl
  // A path stays a path: the placeholder origin must not end up in the log.
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`
}

/** Removes the bearer tokens of a free-form text. */
function redactText(text: string): string {
  return text.replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${REDACTED}`)
}

/** Serializes an error without its stack and with its text redacted. */
function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) }
  }
  if (typeof value === 'string') return redactText(value)
  return value
}

/** Serializes a value, redacting what has to be redacted. */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value)
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveHeader(key) ? REDACTED : serializeValue(nested)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}

/**
 * Redacts a set of fields before they are logged.
 *
 * The fields are walked recursively: a sensitive header is redacted wherever
 * it appears, and a bearer token is removed from every string.
 */
export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSensitiveHeader(key) ? REDACTED : serializeValue(value)
  }
  return out
}

export interface LoggerOptions {
  level?: LogLevel
  bindings?: LogFields
  /** The sink of the lines; overridable for the tests. */
  write?: (line: string) => void
}

/**
 * Creates the logger of the gateway.
 *
 * The fields are redacted before they reach the library, so a credential
 * never ends up in the output.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const logger = pino(
    {
      level,
      // The bindings replace the default base, so the process id and the
      // hostname are not part of the log.
      base: options.bindings ?? {},
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: {
        level(label: string) {
          return { level: label }
        },
      },
    },
    options.write ? { write: options.write } : undefined
  )
  const emit = (
    write: (fields: LogFields, message: string) => void,
    message: string,
    fields?: LogFields
  ): void => {
    write(fields ? redactFields(fields) : {}, redactText(message))
  }
  return {
    level,
    debug: (message, fields) => emit((f, m) => logger.debug(f, m), message, fields),
    info: (message, fields) => emit((f, m) => logger.info(f, m), message, fields),
    warn: (message, fields) => emit((f, m) => logger.warn(f, m), message, fields),
    error: (message, fields) => emit((f, m) => logger.error(f, m), message, fields),
  }
}

/** Parses a level of the log, falling back to `info`. */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) return fallback
  const normalized = value.toLowerCase() as LogLevel
  return ['debug', 'info', 'warn', 'error', 'silent'].includes(normalized) ? normalized : fallback
}

/** A logger that writes nothing; it is used by the tests. */
export function createSilentLogger(): Logger {
  return {
    level: 'silent',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}
