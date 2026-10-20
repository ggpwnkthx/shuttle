/**
 * The store of the sessions that lives in a Redis server.
 *
 * The Redis wire protocol is spoken by most managed caches (Amazon
 * ElastiCache, Google Cloud Memorystore, Azure Cache for Redis, Aiven,
 * Upstash and a Helm managed Redis on Kubernetes), so one implementation
 * covers every provider a deployment can offer.
 *
 * The refresh of the expiry of a session is **one** script of the server:
 *
 * - it reads the record and checks the maximum age of the session, and it
 *   removes the session when it is over;
 * - it refreshes the expiry only when the touch interval is over, so a busy
 *   caller is not written on every request, and the interval is the same on
 *   every replica;
 * - the new expiry never reaches beyond the maximum age of the session;
 * - a session that was deleted (a logout) is never recreated: the script
 *   only refreshes a session that it found.
 */

import {
  isPastIdleLifetime,
  isPastMaximumAge,
  newSessionRecord,
  parseSessionRecord,
  serializeSessionRecord,
  type CreateSessionInput,
  type SessionLifetime,
  type SessionRecord,
  type SessionStore,
} from '../session'

/**
 * The part of a Redis client the store needs.
 *
 * The domain does not know the client of the runtime: it knows the commands
 * it sends, and the platform builds a client that speaks them.
 */
export interface RedisSessionCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  ping(): Promise<string>
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>
}

/**
 * The script that reads a session and refreshes its expiry.
 *
 * It returns the record of the session (the refreshed one when the expiry
 * was refreshed) or an empty string when the session does not exist or is
 * older than its maximum age.
 */
export const TOUCH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local idle = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local record = cjson.decode(raw)
local absolute = tonumber(record.absoluteExpiresAt) or 0
if absolute > 0 and now >= absolute then
  redis.call('DEL', KEYS[1])
  return ''
end
local expires = tonumber(record.expiresAt) or 0
local lastTouch = expires - idle
if now - lastTouch >= interval then
  local ttl = idle
  if absolute > 0 then
    local left = absolute - now
    if left < ttl then ttl = left end
  end
  if ttl <= 0 then
    redis.call('DEL', KEYS[1])
    return ''
  end
  record.expiresAt = now + ttl
  local ok, encoded = pcall(cjson.encode, record)
  if ok then
    redis.call('SET', KEYS[1], encoded, 'PX', ttl)
  else
    redis.call('PEXPIRE', KEYS[1], ttl)
  end
  return encoded
end
return raw
`

export interface RedisSessionStoreOptions extends Partial<SessionLifetime> {
  /** The client of the server. */
  client: RedisSessionCommands
  /** Prefix of every key, so several environments can share one server. */
  keyPrefix?: string
}

/**
 * The shared session store.
 *
 * There is exactly one behaviour when the store cannot be reached: the
 * request is denied. A gateway that mirrors the sessions in its own memory
 * would authenticate a caller that no other replica knows.
 */
export class RedisSessionStore implements SessionStore {
  #client: RedisSessionCommands
  #prefix: string
  #lifetime: SessionLifetime

  constructor(options: RedisSessionStoreOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#lifetime = {
      ttlMs: options.ttlMs ?? 8 * 60 * 60_000,
      maxAgeMs: options.maxAgeMs ?? 24 * 60 * 60_000,
      touchIntervalMs: options.touchIntervalMs ?? 60_000,
    }
  }

  get ttlMs(): number {
    return this.#lifetime.ttlMs
  }

  get maxAgeMs(): number {
    return this.#lifetime.maxAgeMs
  }

  get touchIntervalMs(): number {
    return this.#lifetime.touchIntervalMs
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now()
    const record = newSessionRecord(input, this.#lifetime, now)
    await this.#client.set(
      this.#sessionKey(record.id),
      serializeSessionRecord(record),
      'PX',
      this.#lifetime.ttlMs
    )
    return record
  }

  async get(id: string | undefined): Promise<SessionRecord | null> {
    if (!id) return null
    const now = Date.now()
    const raw = await this.#client.eval(
      TOUCH_SCRIPT,
      1,
      this.#sessionKey(id),
      this.#lifetime.ttlMs,
      now,
      this.#lifetime.touchIntervalMs
    )
    if (typeof raw !== 'string' || raw === '') return null
    const record = parseSessionRecord(raw, now)
    if (!record) {
      await this.destroy(id)
      return null
    }
    if (isPastMaximumAge(record, now) || isPastIdleLifetime(record, now)) {
      await this.destroy(id)
      return null
    }
    return record
  }

  async destroy(id: string | undefined): Promise<void> {
    if (!id) return
    await this.#client.del(this.#sessionKey(id))
  }

  async ping(): Promise<boolean> {
    try {
      await this.#client.ping()
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    // The client is owned by the runtime.
  }

  /** The key of a session. */
  #sessionKey(id: string): string {
    return `${this.#prefix}:s:${id}`
  }
}
