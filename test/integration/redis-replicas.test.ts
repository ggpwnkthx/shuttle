import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createRedisClient, withRetries } from '../../src/platform/redis'

/**
 * The shared state between the replicas.
 *
 * The counters of the replicas have to be exact: a counter that loses an
 * increment lets a caller make more requests than the budget allows, and the
 * limit of the deployment is the limit of the configuration and not the limit
 * of a replica.
 *
 * The test starts several **processes** at the same time: the commands of
 * the processes are interleaved by the server, and the count has to be
 * exact anyway.
 */
const url = process.env.SHUTTLE_TEST_REDIS_URL
const describeRedis = url ? describe : describe.skip

describeRedis('the shared state of the replicas', () => {
  test('the counter of the processes is exact', async () => {
    const key = `test-replica-${Date.now()}`
    const workers = 4
    const perWorker = 25

    const processes = Array.from({ length: workers }, () =>
      Bun.spawn(['bun', 'run', join(import.meta.dir, 'replica-worker.ts')], {
        env: {
          ...process.env,
          SHUTTLE_TEST_REDIS_URL: url!,
          SHUTTLE_TEST_REDIS_KEY: key,
          SHUTTLE_TEST_REDIS_COUNT: String(perWorker),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    )

    const outputs = await Promise.all(
      processes.map(async (child) => {
        const stdout = await new Response(child.stdout).text()
        const code = await child.exited
        expect(code).toBe(0)
        return JSON.parse(stdout.trim()) as { results: number[] }
      })
    )

    const counters = outputs.flatMap((output) => output.results).sort((left, right) => left - right)
    // Every command of every process is counted: the counters have no gap
    // and the biggest one is the number of the commands.
    expect(counters.length).toBe(workers * perWorker)
    expect(counters[counters.length - 1]).toBe(workers * perWorker)
    for (let index = 0; index < counters.length; index++) {
      expect(counters[index]).toBe(index + 1)
    }
  })

  test('the keys of the workers expire on their own', async () => {
    const client = withRetries(createRedisClient({ url: url! }))
    const key = `test-replica-ttl-${Date.now()}`
    await client.set(key, 'value', 'PX', 1000)
    const ttl = await client.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1)
    client.close()
  })
})
