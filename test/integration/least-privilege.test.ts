/**
 * The least privilege of the shared state.
 *
 * The real boundary of the control plane is the credential of the shared
 * state and not the token of the caller (§12.8 of the specification): the
 * gateway may read the route table and it may not write it, and only the
 * role of the control plane writes it.
 *
 * The tests prove it against the two servers. The Postgres part needs a
 * server whose administrator may create the roles, and the Redis part
 * needs a server whose administrator may create the ACL users: without
 * them the tests are skipped, and the CI workflow runs them against the
 * services of the workflow.
 */

import { describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { createPostgresClient, ensureSchema } from '../../src/platform/postgres'
import {
  CONTROL_ROLE,
  GATEWAY_ROLE,
  ROLE_GRANTS,
  ROLE_STATEMENTS,
} from '../../src/platform/postgres'
import { createRedisClient, withRetries } from '../../src/platform/redis'
import { PostgresRouteTableStore } from '../../src/domains/configuration/adapters'
import type { AuditEntry } from '../../src/domains/configuration'

/** A namespace that is unique to the run, so the runs do not collide. */
function namespace(): string {
  return `least-privilege-${Date.now()}-${Math.floor(Math.random() * 1_000_000).toString(36)}`
}

/** The url of the Postgres server of the tests. */
const postgresUrl = process.env.SHUTTLE_TEST_POSTGRES_URL
/** The url of the Redis server of the tests. */
const redisUrl = process.env.SHUTTLE_TEST_REDIS_URL

/** The entry of the audit trail of a write. */
const audit: AuditEntry = {
  action: 'config.write',
  target: 'route-table',
  operator: 'the-operator',
  scope: 'config',
  address: '127.0.0.1',
  request: {},
  at: Date.now(),
}

/** The table of the tests. */
const table = {
  version: 1,
  routes: [
    {
      id: 'admin',
      match: { host: 'admin.shuttle.test', path: '/admin' },
      upstream: 'http://upstream.test',
      auth: { mode: 'none' },
    },
  ],
}

/** Replaces the credentials of an url. */
function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url)
  parsed.username = user
  parsed.password = password
  return parsed.toString()
}

describe('the least privilege of the shared state', () => {
  test.skipIf(!postgresUrl)('the role of the gateway cannot write the route table', async () => {
    const admin = createPostgresClient({ url: postgresUrl! })
    try {
      // The schema is built by the administrator: the roles are granted on
      // the tables of the shared state.
      await ensureSchema(admin)
      for (const statement of ROLE_STATEMENTS) {
        await admin.query(statement)
      }
      for (const statement of ROLE_GRANTS) {
        await admin.query(statement)
      }
      await admin.query(`ALTER ROLE ${GATEWAY_ROLE} PASSWORD 'the-password-of-the-gateway'`)
      await admin.query(`ALTER ROLE ${CONTROL_ROLE} PASSWORD 'the-password-of-the-control'`)
    } finally {
      await admin.close()
    }

    // The gateway reads the route table and writes nothing in it.
    const gateway = new Pool({
      connectionString: withCredentials(postgresUrl!, GATEWAY_ROLE, 'the-password-of-the-gateway'),
      max: 2,
    })
    try {
      const store = new PostgresRouteTableStore({
        client: {
          query: async <T>(text: string, params: readonly unknown[] = []) => {
            const result = await gateway.query(text, params as unknown[])
            return { rows: result.rows as T[] }
          },
          transaction: async <T>(
            body: (client: {
              query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>
            }) => Promise<T>
          ) => {
            const client = await gateway.connect()
            try {
              await client.query('BEGIN')
              const result = await body({
                query: async <R>(text: string, params: readonly unknown[] = []) => {
                  const outcome = await client.query(text, params as unknown[])
                  return { rows: outcome.rows as R[] }
                },
              })
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined)
              throw error
            } finally {
              client.release()
            }
          },
        },
        namespace: namespace(),
      })

      // The read works: the gateway needs the table of the deployment.
      const pointer = await store.activePointer()
      expect(pointer === null || typeof pointer.revision === 'number').toBe(true)

      // The write is refused: the credentials of the gateway may not write
      // the route table.
      let refused = false
      try {
        await store.writeRevision({
          table,
          author: 'the-operator',
          expectedRevision: null,
          audit,
        })
      } catch (error) {
        refused = true
        expect(String(error)).toContain('permission denied')
      }
      expect(refused).toBe(true)
    } finally {
      await gateway.end()
    }
  })

  test.skipIf(!postgresUrl)('the role of the control plane writes the route table', async () => {
    const control = new Pool({
      connectionString: withCredentials(postgresUrl!, CONTROL_ROLE, 'the-password-of-the-control'),
      max: 2,
    })
    try {
      const store = new PostgresRouteTableStore({
        client: {
          query: async <T>(text: string, params: readonly unknown[] = []) => {
            const result = await control.query(text, params as unknown[])
            return { rows: result.rows as T[] }
          },
          transaction: async <T>(
            body: (client: {
              query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>
            }) => Promise<T>
          ) => {
            const client = await control.connect()
            try {
              await client.query('BEGIN')
              const result = await body({
                query: async <R>(text: string, params: readonly unknown[] = []) => {
                  const outcome = await client.query(text, params as unknown[])
                  return { rows: outcome.rows as R[] }
                },
              })
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined)
              throw error
            } finally {
              client.release()
            }
          },
        },
        namespace: namespace(),
      })

      const outcome = await store.writeRevision({
        table,
        author: 'the-operator',
        expectedRevision: null,
        audit,
      })
      expect(outcome.ok).toBe(true)
    } finally {
      await control.end()
    }
  })

  test.skipIf(!redisUrl)('the user of the gateway cannot write the route table', async () => {
    const admin = withRetries(createRedisClient({ url: redisUrl! }))
    const prefix = `least-privilege-${Date.now()}`
    try {
      // The user of the gateway reads the route table and writes the
      // sessions and the heartbeats. It does not hold the commands that
      // write the revisions, the pointer and the history.
      await admin.sendCommand([
        'ACL',
        'SETUSER',
        'shuttle-gateway-test',
        'reset',
        'on',
        '>the-password-of-the-gateway',
        // Everything is refused first, and the commands of the gateway are
        // granted afterwards: the order of the rules is the order of the
        // commands.
        '-@all',
        `>~${prefix}:s:*`,
        `>~${prefix}:u:*`,
        `>~${prefix}:cfg:hb:*`,
        `~${prefix}:cfg:active`,
        `~${prefix}:cfg:rev:*`,
        `~${prefix}:cfg:revs`,
        '+@read',
        '+set',
        '+del',
        '+sadd',
        '+srem',
        '+pexpire',
        '+incr',
        '+hincrby',
        '+hdel',
        '+eval',
      ])
      await admin.sendCommand([
        'ACL',
        'SETUSER',
        'shuttle-control-test',
        'reset',
        'on',
        '>the-password-of-the-control',
        '-@all',
        `>~${prefix}:*`,
        '+@read',
        '+@write',
      ])
    } finally {
      await admin.close()
    }

    const gatewayUrl = new URL(redisUrl!)
    gatewayUrl.username = 'shuttle-gateway-test'
    gatewayUrl.password = 'the-password-of-the-gateway'
    const gateway = withRetries(createRedisClient({ url: gatewayUrl.toString() }))
    try {
      // The read works: the gateway needs the table of the deployment.
      const read = await gateway.hget(`${prefix}:cfg:active`, 'revision')
      expect(read === null || typeof read === 'string').toBe(true)

      // The write is refused: the user of the gateway does not hold the
      // commands that write the route table.
      let refused = false
      try {
        await gateway.eval(
          `local number = redis.call('INCR', KEYS[1])
           redis.call('HSET', KEYS[2], 'revision', number)
           return tostring(number)`,
          2,
          `${prefix}:cfg:seq`,
          `${prefix}:cfg:active`
        )
      } catch (error) {
        refused = true
        expect(String(error)).toContain('NOPERM')
      }
      expect(refused).toBe(true)
    } finally {
      await gateway.close()
      const cleanup = withRetries(createRedisClient({ url: redisUrl! }))
      try {
        await cleanup.sendCommand(['ACL', 'DELUSER', 'shuttle-gateway-test'])
        await cleanup.sendCommand(['ACL', 'DELUSER', 'shuttle-control-test'])
      } finally {
        await cleanup.close()
      }
    }
  })
})
