#!/usr/bin/env bun
/**
 * A worker of the test of the shared state of a Postgres server.
 *
 * The script counts in a window of the shared state, exactly like a replica
 * of the gateway does, and prints the counters it read. The test starts
 * several of them at the same time: the counter has to be exact, whatever
 * the number of the processes and whatever the order of their commands.
 */
import { PostgresRateLimiter } from '../../src/domains/rate-limiting/adapters'
import { createPostgresClient, withPostgresRetries } from '../../src/platform/postgres'

const url = process.env.SHUTTLE_TEST_POSTGRES_URL
const key = process.env.SHUTTLE_TEST_POSTGRES_KEY
const count = Number(process.env.SHUTTLE_TEST_POSTGRES_COUNT ?? '1')

if (!url || !key) {
  console.error('the worker needs SHUTTLE_TEST_POSTGRES_URL and SHUTTLE_TEST_POSTGRES_KEY')
  process.exit(2)
}

const client = withPostgresRetries(createPostgresClient({ url }))
const limiter = new PostgresRateLimiter({
  client,
  keyPrefix: 'replica-worker',
  max: 1_000_000,
  windowMs: 60_000,
})

const results: number[] = []
for (let index = 0; index < count; index++) {
  const decision = await limiter.check(key)
  // The limiter reports what is left of the budget: the count of the
  // window is the budget minus what is left.
  results.push(decision.limit - decision.remaining)
}

// The worker reports the counters it read: the biggest one is the count of
// the window, and the counters of a window have no gap.
console.log(JSON.stringify({ results }))
await client.close()
