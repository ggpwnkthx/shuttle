#!/usr/bin/env bun
/**
 * The migration of the schema of the shared state.
 *
 * A deployment that applies its own migrations runs this script against its
 * database before it starts the gateway:
 *
 *   bun run postgres:migrate -- postgres://user:password@host:5432/shuttle
 *
 * The statements are idempotent: the script can be run again, and it does
 * nothing when the schema is already there. The gateway builds the schema
 * itself when `SHUTTLE_POSTGRES_AUTO_MIGRATE=true`, which is the default
 * outside a production deployment; a production deployment that applies
 * its own migrations says no there and runs this script instead.
 */
import { createPostgresClient, ensureSchema, isPostgresUrl } from '../src/platform/postgres'

async function main(): Promise<void> {
  const url = process.argv[2] ?? process.env.SHUTTLE_SESSION_URL
  if (!url) {
    console.error(
      'the migration needs the url of the database: bun run postgres:migrate -- postgres://user:password@host:5432/shuttle'
    )
    process.exit(1)
  }
  if (!isPostgresUrl(url)) {
    console.error(`the url does not name a Postgres server: ${url}`)
    process.exit(1)
  }

  const client = createPostgresClient({ url })
  try {
    await ensureSchema(client)
    console.log('the schema of the shared state is up to date')
  } finally {
    await client.close()
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
