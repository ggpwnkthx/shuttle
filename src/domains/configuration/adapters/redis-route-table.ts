/**
 * The route table in a Redis server.
 *
 * The store is the counterpart of the one of Postgres: the same contract,
 * the same behaviour, another server. The conformance suite of the shared
 * state runs against the two and proves that they behave the same way.
 *
 * The keys of the route table live under the prefix of the state they are
 * in, next to the sessions:
 *
 * | Key | What it holds |
 * | --- | --- |
 * | `<prefix>:cfg:active` | The revision that is active, in a hash. |
 * | `<prefix>:cfg:rev:<n>` | The revision `n`, in a hash. |
 * | `<prefix>:cfg:revs` | The revisions, the oldest first, in a list. |
 * | `<prefix>:cfg:seq` | The number of the last revision. |
 * | `<prefix>:cfg:hb:<replica>` | The heartbeat of a replica, with its expiry. |
 *
 * The write of a revision is **one script** of the server: it reads the
 * pointer, refuses the write when the pointer moved, writes the revision,
 * moves the pointer and writes the entry of the audit trail. A script is a
 * transaction of the server, so the trail and the table cannot exist
 * without each other.
 *
 * The revisions and the pointer are **hashes** and the history is a
 * **list**: the gateway reads them with the read commands of the server,
 * and it never holds the commands that write them. The roles of the shared
 * state are then the same on the two servers: the gateway may read the
 * route table and it may not write it (§12.8 of the specification).
 */

import { parseAudit, serializeAudit } from '../../../observability'
import type {
  AuditEntry,
  Page,
  ReplicaHeartbeat,
  RouteTablePointer,
  RouteTableRevision,
  RouteTableStore,
  WriteOutcome,
} from '../revisions'

/**
 * The part of a Redis client the store needs.
 *
 * The domain does not know the client of the runtime: it knows the commands
 * it sends, and the platform builds a client that speaks them.
 */
export interface RedisRouteTableCommands {
  get(key: string): Promise<string | null>
  /** The value of a field of a hash. */
  hget(key: string, field: string): Promise<string | null>
  /** The fields of a hash. */
  hgetall(key: string): Promise<Record<string, string>>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>
  /** Appends a value at the end of a list. */
  rpush(key: string, ...values: string[]): Promise<number>
  /** The values of a list, between two indexes. */
  lrange(key: string, start: number, stop: number): Promise<string[]>
  /** The number of values of a list. */
  llen(key: string): Promise<number>
  /** Grows a counter by one. */
  incr(key: string): Promise<number>
  /** The keys that match a pattern. */
  keys(pattern: string): Promise<string[]>
  /** The lifetime of a key, in milliseconds. */
  pexpire(key: string, ms: number): Promise<number>
}

/**
 * The script that writes a revision and moves the pointer.
 *
 * It returns `{1, <number>}` when the write happened and `{0, <active>}`
 * when the pointer moved: the writer that lost the race is told which
 * revision is active, so it can tell the operator what happened.
 */
export const WRITE_REVISION_SCRIPT = `
local active = redis.call('HGET', KEYS[1], 'revision')
local current = ''
if active then current = active end
if current ~= ARGV[1] then
  return {0, current}
end
local number = redis.call('INCR', KEYS[3])
local record = '{"revision":' .. number .. ',"table":' .. ARGV[2] ..
  ',"author":' .. cjson.encode(ARGV[3]) .. ',"createdAt":' .. ARGV[4] .. '}'
redis.call('HSET', ARGV[5] .. number, 'revision', number, 'table', ARGV[2],
           'author', ARGV[3], 'createdAt', ARGV[4])
redis.call('RPUSH', KEYS[2], record)
redis.call('HSET', KEYS[1], 'revision', number, 'updatedAt', ARGV[4])
redis.call('RPUSH', KEYS[4], ARGV[6])
return {1, tostring(number)}
`

export interface RedisRouteTableStoreOptions {
  /** The client of the server. */
  client: RedisRouteTableCommands
  /** The prefix of the keys, the one of the state the table lives in. */
  keyPrefix?: string
  /** The key of the audit trail of the state. */
  auditKey?: string
}

/**
 * The route table of a Redis server.
 *
 * The store is the one the control plane writes and the one the gateway
 * reads: the gateway never writes a revision, it only reads the pointer
 * and writes its own heartbeat.
 */
export class RedisRouteTableStore implements RouteTableStore {
  #client: RedisRouteTableCommands
  #prefix: string
  #auditKey: string

  constructor(options: RedisRouteTableStoreOptions) {
    this.#client = options.client
    this.#prefix = options.keyPrefix ?? 'shuttle'
    this.#auditKey = options.auditKey ?? `${this.#prefix}:audit`
  }

  async activePointer(): Promise<RouteTablePointer | null> {
    const raw = await this.#client.hget(this.#activeKey(), 'revision')
    if (typeof raw !== 'string' || raw === '') return null
    const revision = Number(raw)
    if (!Number.isFinite(revision)) return null
    return { revision }
  }

  async readRevision(revision: number): Promise<RouteTableRevision | null> {
    const fields = await this.#client.hgetall(this.#revisionKey(revision))
    const number = Number(fields.revision)
    if (!Number.isFinite(number)) return null
    let table: unknown = null
    if (typeof fields.table === 'string' && fields.table !== '') {
      try {
        table = JSON.parse(fields.table)
      } catch {
        table = null
      }
    }
    return {
      revision: number,
      table,
      author: typeof fields.author === 'string' ? fields.author : '',
      createdAt: Number(fields.createdAt ?? 0) || 0,
    }
  }

  async listRevisions(options: {
    limit: number
    offset: number
  }): Promise<Page<RouteTableRevision>> {
    const total = await this.#client.llen(this.#revisionsKey())
    const entries: RouteTableRevision[] = []
    if (total > 0) {
      // The list holds the revisions from the oldest to the newest, and the
      // page is the newest first: the range is read from the end.
      const start = Math.max(0, total - options.offset - options.limit)
      const stop = Math.max(0, total - options.offset - 1)
      const raw = await this.#client.lrange(this.#revisionsKey(), start, stop)
      for (const entry of raw) {
        const revision = parseRevision(entry)
        if (revision) entries.push(revision)
      }
      entries.reverse()
    }
    return { entries, total }
  }

  async writeRevision(input: {
    table: unknown
    author: string
    expectedRevision: number | null
    audit: AuditEntry
  }): Promise<WriteOutcome> {
    const table = JSON.stringify(input.table ?? null)
    const outcome = await this.#client.eval(
      WRITE_REVISION_SCRIPT,
      4,
      this.#activeKey(),
      this.#revisionsKey(),
      this.#sequenceKey(),
      this.#auditKey,
      input.expectedRevision === null ? '' : String(input.expectedRevision),
      table,
      input.author,
      Date.now(),
      this.#revisionKey(''),
      serializeAudit(input.audit)
    )
    const written = Array.isArray(outcome) ? outcome[0] : undefined
    const value = Array.isArray(outcome) ? outcome[1] : undefined
    if (Number(written) === 1) {
      return { ok: true, revision: Number(value) }
    }
    const active = typeof value === 'string' && value !== '' ? Number(value) : null
    return { ok: false, reason: 'conflict', active }
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.#client.rpush(this.#auditKey, serializeAudit(entry))
  }

  async listAudit(options: { limit: number; offset: number }): Promise<Page<AuditEntry>> {
    const total = await this.#client.llen(this.#auditKey)
    const entries: AuditEntry[] = []
    if (total > 0) {
      const start = Math.max(0, total - options.offset - options.limit)
      const stop = Math.max(0, total - options.offset - 1)
      const raw = await this.#client.lrange(this.#auditKey, start, stop)
      for (const entry of raw) {
        const parsed = parseAudit(entry)
        if (parsed) entries.push(parsed)
      }
      entries.reverse()
    }
    return { entries, total }
  }

  async ping(): Promise<boolean> {
    try {
      await this.#client.hget(this.#activeKey(), 'revision')
      return true
    } catch {
      return false
    }
  }

  async writeHeartbeat(heartbeat: ReplicaHeartbeat, lifetimeMs: number): Promise<void> {
    await this.#client.set(
      this.#heartbeatKey(heartbeat.replicaId),
      JSON.stringify(heartbeat),
      'PX',
      Math.max(1, Math.floor(lifetimeMs))
    )
  }

  async listHeartbeats(): Promise<ReplicaHeartbeat[]> {
    const keys = await this.#client.keys(`${this.#prefix}:cfg:hb:*`)
    const heartbeats: ReplicaHeartbeat[] = []
    for (const key of keys) {
      const raw = await this.#client.get(key)
      if (typeof raw !== 'string' || raw === '') continue
      const parsed = parseHeartbeat(raw)
      if (parsed) heartbeats.push(parsed)
    }
    return heartbeats.sort((left, right) => left.replicaId.localeCompare(right.replicaId))
  }

  /** The key of the pointer. */
  #activeKey(): string {
    return `${this.#prefix}:cfg:active`
  }

  /** The key of the list of the revisions. */
  #revisionsKey(): string {
    return `${this.#prefix}:cfg:revs`
  }

  /** The key of the counter of the revisions. */
  #sequenceKey(): string {
    return `${this.#prefix}:cfg:seq`
  }

  /** The key of a revision. */
  #revisionKey(revision: number | string): string {
    return `${this.#prefix}:cfg:rev:${revision}`
  }

  /** The key of the heartbeat of a replica. */
  #heartbeatKey(replicaId: string): string {
    return `${this.#prefix}:cfg:hb:${replicaId}`
  }
}

/** Reads a revision of the trail. */
function parseRevision(raw: string): RouteTableRevision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Partial<RouteTableRevision>
  if (typeof record.revision !== 'number') return null
  return {
    revision: record.revision,
    table: record.table ?? null,
    author: typeof record.author === 'string' ? record.author : '',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
  }
}

/** Reads the heartbeat of a replica. */
function parseHeartbeat(raw: string): ReplicaHeartbeat | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const heartbeat = parsed as Partial<ReplicaHeartbeat>
  if (typeof heartbeat.replicaId !== 'string') return null
  return {
    replicaId: heartbeat.replicaId,
    revision: typeof heartbeat.revision === 'number' ? heartbeat.revision : null,
    lastError: typeof heartbeat.lastError === 'string' ? heartbeat.lastError : null,
    at: typeof heartbeat.at === 'number' ? heartbeat.at : 0,
  }
}
