/**
 * The shared state in a Postgres server.
 *
 * The suite is the one of `shared-state-conformance.ts`: it is the same
 * contract that the Redis server has to show, so the two are proven to be
 * interchangeable.
 *
 * The tests run against a real server when `SHUTTLE_TEST_POSTGRES_URL`
 * names one, and against the in-process engine of Postgres otherwise.
 */

import { afterAll, beforeAll, describe } from 'bun:test'
import { PostgresSessionStore } from '../../src/domains/authentication/adapters'
import { PostgresRateLimiter } from '../../src/domains/rate-limiting/adapters'
import { PostgresDecisionCache } from '../../src/domains/workspace-access/adapters'
import { PostgresRouteTableStore } from '../../src/domains/configuration/adapters'
import {
  describeDecisionCache,
  describeRateLimiter,
  describeRouteTableStore,
  describeSessionStore,
} from './shared-state-conformance'
import { startPostgres, type PostgresTestServer } from './postgres-server'

let server: PostgresTestServer | undefined

/** A prefix that is unique to the run, so the runs do not collide. */
const prefix = `test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

/** A suffix that is unique to the store, so the tests do not collide. */
function random(): string {
  return Math.floor(Math.random() * 1_000_000).toString(36)
}

beforeAll(async () => {
  server = await startPostgres()
})

afterAll(async () => {
  await server?.close()
})

describe('the shared state in a Postgres server', () => {
  describeSessionStore(
    'a Postgres server',
    (options) =>
      new PostgresSessionStore({ client: server!, keyPrefix: `${prefix}:session`, ...options })
  )

  describeRateLimiter(
    'a Postgres server',
    (options) => new PostgresRateLimiter({ client: server!, keyPrefix: `${prefix}:rl`, ...options })
  )

  describeDecisionCache(
    'a Postgres server',
    () => new PostgresDecisionCache({ client: server!, keyPrefix: `${prefix}:dec` })
  )

  describeRouteTableStore(
    'a Postgres server',
    // The namespace is unique to the store: the tests of the suite do not
    // share the route table of each other.
    () => new PostgresRouteTableStore({ client: server!, namespace: `${prefix}:${random()}` })
  )
})
