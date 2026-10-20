#!/usr/bin/env bun
/**
 * A worker of the test of the shared state.
 *
 * The script counts in a window of the shared state, exactly like a replica
 * of the gateway does, and prints the counter it read. The test starts
 * several of them at the same time: the counter has to be exact, whatever
 * the number of the processes and whatever the order of their commands.
 */
import { createRedisClient, withRetries } from '../../src/platform/redis'

const url = process.env.SHUTTLE_TEST_REDIS_URL
const key = process.env.SHUTTLE_TEST_REDIS_KEY
const count = Number(process.env.SHUTTLE_TEST_REDIS_COUNT ?? '1')

if (!url || !key) {
  console.error('the worker needs SHUTTLE_TEST_REDIS_URL and SHUTTLE_TEST_REDIS_KEY')
  process.exit(2)
}

const client = withRetries(createRedisClient({ url }))
const script = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return current
`

const results: number[] = []
for (let index = 0; index < count; index++) {
  results.push(Number(await client.eval(script, 1, key, 60_000)))
}

// The worker reports the counters it read: the biggest one is the count of
// the window, and the counters of a window have no gap.
console.log(JSON.stringify({ results }))
client.close()
