/**
 * The shared state in a Redis server.
 *
 * The suite is the one of `shared-state-conformance.ts`: it is the same
 * contract that the Postgres server has to show, so the two are proven to be
 * interchangeable.
 *
 * The tests run when `SHUTTLE_TEST_REDIS_URL` names a server; without it
 * they are skipped, and the CI workflow runs them against a Redis service.
 */

import { describe as describeOnly } from 'bun:test'
import { RedisSessionStore } from '../../src/domains/authentication/adapters'
import { RedisRateLimiter } from '../../src/domains/rate-limiting/adapters'
import { RedisDecisionCache } from '../../src/domains/workspace-access/adapters'
import { createRedisClient, withRetries } from '../../src/platform/redis'
import {
  describeDecisionCache,
  describeRateLimiter,
  describeSessionStore,
} from './shared-state-conformance'

const url = process.env.SHUTTLE_TEST_REDIS_URL
const describeRedis = url ? describeOnly : describeOnly.skip

/** A prefix that is unique to the run, so the runs do not collide. */
const prefix = `test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

describeRedis('the shared state in a Redis server', () => {
  describeSessionStore(
    'a Redis server',
    (options) =>
      new RedisSessionStore({
        client: withRetries(createRedisClient({ url: url! })),
        keyPrefix: `${prefix}:session`,
        ...options,
      })
  )

  describeRateLimiter(
    'a Redis server',
    (options) =>
      new RedisRateLimiter({
        client: withRetries(createRedisClient({ url: url! })),
        keyPrefix: `${prefix}:rl`,
        ...options,
      })
  )

  describeDecisionCache(
    'a Redis server',
    () =>
      new RedisDecisionCache({
        client: withRetries(createRedisClient({ url: url! })),
        keyPrefix: `${prefix}:dec`,
      })
  )
})
