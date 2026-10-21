/**
 * The plumbing of the Redis connections.
 *
 * The gateway talks to a Redis compatible server for two things: the
 * sessions, and the state that is shared between the replicas (the rate
 * limits and the cached access decisions). Both use the same connection
 * settings, so the plumbing lives here.
 *
 * The client is the one of the `redis` package. It speaks the wire protocol
 * of Redis, so one implementation covers every managed cache (Amazon
 * ElastiCache, Google Cloud Memorystore, Azure Cache for Redis, Aiven,
 * Upstash and a Helm managed Redis on Kubernetes), and it is not tied to
 * the runtime of the gateway: the shared state is the one part of the
 * deployment that has to survive a change of runtime.
 *
 * The **offline queue is disabled** on purpose: a command that is sent
 * before the handshake of the connection is done fails right away instead
 * of waiting in a queue that nobody drains. The gateway denies the caller
 * when the store is down, it does not pile up requests.
 *
 * The client connects in the background and keeps trying: a gateway that
 * starts while the shared state is down stays up, reports that it is not
 * ready, and becomes ready when the server answers.
 */

import {
  createClient,
  createCluster,
  createSentinel,
  type RedisClientOptions as NodeRedisClientOptions,
} from 'redis'

/** Reports whether an url names a Redis server. */
export function isRedisUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return url.startsWith('redis://') || url.startsWith('rediss://')
}

export interface RedisClientOptions {
  /** Connection url, for example `rediss://:password@host:6379/0`. */
  url: string
  /** PEM encoded certificate authority for a private endpoint. */
  tlsCa?: string
  /** How long the client waits for the connection to be established. */
  connectionTimeoutMs?: number
  /**
   * The name of the master, when the server is behind sentinel.
   *
   * The hosts of the url are then the sentinels, and the client discovers
   * the master and the replicas from them.
   */
  sentinelMaster?: string
  /**
   * Called when the connection fails.
   *
   * It is called once per outage: the client keeps trying to connect, and
   * a server that is down does not have to fill the log of the gateway.
   */
  onError?: (error: unknown) => void
}

/**
 * The commands of the shared state, plus the ones the operations use.
 *
 * The domains talk to the server through the port of the domain; the
 * commands that are here are the ones the runtime and the tests use.
 */
export interface SharedStateClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<number>
  ping(): Promise<string>
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>
  keys(pattern: string): Promise<string[]>
  ttl(key: string): Promise<number>
  /** Closes the connection. */
  close(): Promise<void>
}

/**
 * The client of the `redis` package, in the two shapes it has.
 *
 * The shape of the two is the one the domains use: the commands of the
 * wire protocol and the events of the connection. The platform does not
 * use the rest of the client of the package.
 */
interface RawClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options: { PX?: number; EX?: number }): Promise<unknown>
  del(key: string): Promise<number>
  ping(): Promise<string>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  keys(pattern: string): Promise<string[]>
  ttl(key: string): Promise<number>
  on(event: string, listener: (...args: never[]) => void): unknown
  connect(): Promise<void>
  quit(): Promise<string>
  destroy(): void
}

/**
 * The client of the shared state.
 *
 * The commands of the port of the domains are the ones of the wire
 * protocol, so the domains do not know the client of the runtime.
 */
class SharedStateClientImpl implements SharedStateClient {
  #client: RawClient
  #closed = false
  /** True when the failure of the connection was already reported. */
  #reported = false
  #onError?: (error: unknown) => void

  constructor(client: RawClient, options: RedisClientOptions) {
    this.#client = client
    this.#onError = options.onError
    client.on('error', (error: unknown) => {
      if (this.#closed || this.#reported) return
      // The client keeps trying to connect: the failure is reported once
      // per outage, and again when the connection is established.
      this.#reported = true
      this.#onError?.(error)
    })
    client.on('ready', () => {
      this.#reported = false
    })
    // The connection is established in the background: a gateway that
    // starts while the shared state is down stays up and becomes ready
    // when the server answers.
    void client.connect().catch(() => undefined)
  }

  async get(key: string): Promise<string | null> {
    return this.#client.get(key)
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    return this.#client.set(key, value, toSetOptions(args))
  }

  async del(key: string): Promise<number> {
    return this.#client.del(key)
  }

  async ping(): Promise<string> {
    return this.#client.ping()
  }

  async eval(
    script: string,
    numkeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown> {
    const keys = keysAndArgs.slice(0, numkeys).map(String)
    const arguments_ = keysAndArgs.slice(numkeys).map(String)
    return this.#client.eval(script, { keys, arguments: arguments_ })
  }

  async keys(pattern: string): Promise<string[]> {
    return this.#client.keys(pattern)
  }

  async ttl(key: string): Promise<number> {
    return this.#client.ttl(key)
  }

  async close(): Promise<void> {
    this.#closed = true
    try {
      // The connection is closed gracefully, but the wait is bounded: a
      // client that is still trying to reach a server that is not there
      // would keep the drain of the gateway waiting for a reply that will
      // never come.
      await Promise.race([
        this.#client.quit(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 500)
          timer.unref?.()
        }),
      ])
    } catch {
      // The connection is already gone: the process is going away.
    } finally {
      this.#client.destroy()
    }
  }
}

/**
 * The options of a `SET` in the shape of the client.
 *
 * The port of the domains passes the options of the command as they are
 * written in the protocol (`PX`, `EX`), and the client of the runtime
 * translates them.
 */
function toSetOptions(args: readonly (string | number)[]): { PX?: number; EX?: number } {
  const options: { PX?: number; EX?: number } = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = String(args[index]).toUpperCase()
    const value = Math.max(1, Math.floor(Number(args[index + 1])))
    if (!Number.isFinite(value)) continue
    if (name === 'PX') options.PX = value
    else if (name === 'EX') options.EX = value
  }
  return options
}

/**
 * The socket options of the client.
 *
 * The certificate of the server is verified with the authority of the
 * deployment.
 */
function socketOptions(options: RedisClientOptions): NonNullable<NodeRedisClientOptions['socket']> {
  const connectTimeout = options.connectionTimeoutMs ?? 5_000
  if (!options.tlsCa) return { connectTimeout }
  return { tls: true, ca: options.tlsCa, connectTimeout }
}

/**
 * The hosts of a url that names several servers.
 *
 * A cluster and a sentinel are named by a list of hosts:
 * `redis://host-a:6379,host-b:6379`.
 */
function parseHosts(url: string): { hosts: string[]; username?: string; password?: string } {
  const withoutScheme = url.replace(/^rediss?:\/\//, '')
  const authority = withoutScheme.split('/')[0] ?? ''
  const at = authority.lastIndexOf('@')
  const credentials = at === -1 ? '' : authority.slice(0, at)
  const hostsPart = at === -1 ? authority : authority.slice(at + 1)
  const colon = credentials.indexOf(':')
  const username =
    colon === -1 ? credentials || undefined : credentials.slice(0, colon) || undefined
  const password = colon === -1 ? undefined : credentials.slice(colon + 1) || undefined
  const hosts = hostsPart
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return { hosts, username, password }
}

/**
 * Creates a client of a Redis server.
 *
 * The url names a server, a cluster of servers when it carries a list of
 * hosts, or the sentinels of a server when the name of the master is set.
 */
export function createRedisClient(options: RedisClientOptions): SharedStateClient {
  const { hosts, username, password } = parseHosts(options.url)
  const socket = socketOptions(options)
  const credentials = { ...(username ? { username } : {}), ...(password ? { password } : {}) }

  if (hosts.length > 1) {
    if (options.sentinelMaster) {
      // The hosts are the sentinels: the master and the replicas are
      // discovered from them.
      const client = createSentinel({
        name: options.sentinelMaster,
        sentinelRootNodes: hosts.map((entry) => toNode(entry)),
        nodeClientOptions: { ...credentials, socket },
        sentinelClientOptions: { ...credentials, socket },
      })
      return new SharedStateClientImpl(client as unknown as RawClient, options)
    }
    // The hosts are the masters of a cluster.
    const client = createCluster({
      rootNodes: hosts.map((entry) => ({ url: toUrl(entry, options.url) })),
      defaults: {
        ...credentials,
        // The offline queue is disabled on purpose: see the note above.
        disableOfflineQueue: true,
        socket,
      },
    })
    return new SharedStateClientImpl(client as unknown as RawClient, options)
  }

  const client = createClient({
    url: options.url,
    // The offline queue is disabled on purpose: see the note above.
    disableOfflineQueue: true,
    socket,
  })
  return new SharedStateClientImpl(client as unknown as RawClient, options)
}

/** The address of a host of a list. */
function toNode(entry: string): { host: string; port: number } {
  const withoutBrackets = entry.replace(/^\[/, '').replace(/\]$/, '')
  const separator = withoutBrackets.lastIndexOf(':')
  if (separator === -1) return { host: withoutBrackets, port: 6379 }
  return {
    host: withoutBrackets.slice(0, separator),
    port: Number(withoutBrackets.slice(separator + 1)) || 6379,
  }
}

/** The url of a host of a list, with the scheme of the original url. */
function toUrl(entry: string, original: string): string {
  const scheme = original.startsWith('rediss://') ? 'rediss' : 'redis'
  const node = toNode(entry)
  return `${scheme}://${node.host}:${node.port}`
}

/**
 * Reports whether an error is the symptom of a connection that is not
 * established yet.
 */
export function isConnectionError(error: unknown): boolean {
  if (!error) return false
  const code = (error as { code?: string }).code
  if (
    code === 'ERR_CLIENT_CLOSED' ||
    code === 'ERR_REDIS_CONNECTION_CLOSED' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /client is closed|client is offline|connection is closed|not connected|ECONNREFUSED|socket closed/i.test(
    message
  )
}
