#!/usr/bin/env bun
/**
 * The revocation of the sessions of a caller.
 *
 * An account that was compromised has to be ended without logging every
 * other caller out. The gateway has no endpoint for it — a gateway that
 * exposes an administrative endpoint is an endpoint an attacker reaches —
 * so the sessions are revoked with this script, against the state the
 * replicas share:
 *
 *   bun run sessions -- --subject alice@example.test
 *
 * The url of the state and the prefix of the deployment come from the
 * environment of the gateway (`SHUTTLE_SESSION_URL` and
 * `SHUTTLE_SESSION_KEY_PREFIX`), and they may be named on the command line
 * as well:
 *
 *   bun run sessions -- --subject alice --url redis://127.0.0.1:6379/0
 *
 * The script never writes a session and never reads one: it removes them.
 * The number of sessions that were removed is printed, and it is the
 * number of logins that were ended.
 */
import { PostgresSessionStore, RedisSessionStore } from '../src/domains/authentication/adapters'
import type { SessionStore } from '../src/domains/authentication'
import { createPostgresClient, isPostgresUrl } from '../src/platform/postgres'
import { createRedisClient, isRedisUrl, withRetries } from '../src/platform/redis'

/** The options of the script, read from the command line. */
interface Options {
  subject?: string
  url?: string
  prefix?: string
}

/** Reads the options of the script. */
function readOptions(argv: string[]): Options {
  const options: Options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--subject' && value !== undefined) {
      options.subject = value
      index += 1
    } else if (argument === '--url' && value !== undefined) {
      options.url = value
      index += 1
    } else if (argument === '--prefix' && value !== undefined) {
      options.prefix = value
      index += 1
    }
  }
  return options
}

/** The store of the sessions of the deployment, and the way to close it. */
interface OpenStore {
  store: SessionStore
  close: () => Promise<void>
}

/** Builds the store of the sessions of the deployment. */
async function openStore(url: string, prefix: string): Promise<OpenStore> {
  if (isRedisUrl(url)) {
    const client = withRetries(createRedisClient({ url }))
    return {
      store: new RedisSessionStore({ client, keyPrefix: prefix }),
      close: () => client.close(),
    }
  }
  if (isPostgresUrl(url)) {
    const client = createPostgresClient({ url })
    return {
      store: new PostgresSessionStore({ client, keyPrefix: prefix }),
      close: () => client.close(),
    }
  }
  throw new Error(`the url does not name a server whose state is shared: ${url}`)
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2))
  const subject = options.subject ?? process.env.SHUTTLE_SESSION_SUBJECT
  if (!subject) {
    console.error(
      'the revocation needs the subject of the caller: bun run sessions -- --subject alice@example.test'
    )
    process.exit(1)
  }
  const url = options.url ?? process.env.SHUTTLE_SESSION_URL
  if (!url) {
    console.error(
      'the revocation needs the url of the state: bun run sessions -- --subject alice --url redis://127.0.0.1:6379/0'
    )
    process.exit(1)
  }
  const prefix = options.prefix ?? process.env.SHUTTLE_SESSION_KEY_PREFIX ?? 'shuttle'

  const { store, close } = await openStore(url, prefix)
  try {
    const removed = await store.destroyBySubject(subject)
    console.log(
      removed === 0
        ? `the subject ${subject} has no session`
        : `the sessions of ${subject} were revoked: ${removed}`
    )
  } finally {
    await close()
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
