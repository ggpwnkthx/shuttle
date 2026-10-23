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
 *
 * The roles of the shared state are created and granted with `--roles`:
 *
 *   bun run postgres:migrate -- --roles postgres://user:password@host:5432/shuttle
 *
 * The two roles are the boundary of the control plane (§12.8 of the
 * specification): the role of the gateway reads the route table and writes
 * nothing in it, and the role of the control plane writes it. The script
 * has to run with a role that may create the roles and grant them, so it
 * is run with an administrator of the database and not with the account of
 * the gateway.
 *
 * The passwords of the two roles are set by the deployment and not by the
 * script: `POSTGRES_GATEWAY_PASSWORD` and `POSTGRES_CONTROL_PASSWORD` set
 * them when they are in the environment.
 */
import {
  createPostgresClient,
  ensureSchema,
  isPostgresUrl,
  ROLE_GRANTS,
  ROLE_STATEMENTS,
  CONTROL_ROLE,
  GATEWAY_ROLE,
} from '../src/platform/postgres'

/** Sets the password of a role, when the deployment named one. */
async function setPassword(
  client: { query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> },
  role: string,
  password: string | undefined
): Promise<void> {
  if (!password) return
  await client.query(`ALTER ROLE ${role} PASSWORD $1`, [password])
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const withRoles = arguments_.includes('--roles')
  const url =
    arguments_.find((argument) => !argument.startsWith('--')) ?? process.env.SHUTTLE_SESSION_URL
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
    // The sessions that were created before the subject was a column are
    // indexed now: a revocation of a subject has to find the sessions that
    // are already there.
    await client.query(
      `UPDATE shuttle.sessions SET subject = record->>'subject' WHERE subject IS NULL AND record->>'subject' IS NOT NULL`
    )
    if (withRoles) {
      for (const statement of ROLE_STATEMENTS) {
        await client.query(statement)
      }
      for (const statement of ROLE_GRANTS) {
        await client.query(statement)
      }
      await setPassword(client, GATEWAY_ROLE, process.env.POSTGRES_GATEWAY_PASSWORD)
      await setPassword(client, CONTROL_ROLE, process.env.POSTGRES_CONTROL_PASSWORD)
      console.log(`the roles ${GATEWAY_ROLE} and ${CONTROL_ROLE} are granted`)
    }
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
