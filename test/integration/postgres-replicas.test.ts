import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { startPostgres, type PostgresTestServer } from './postgres-server'

/**
 * The shared state between the replicas, in a Postgres server.
 *
 * The counters of the replicas have to be exact: a counter that loses an
 * increment lets a caller make more requests than the budget allows, and
 * the limit of the deployment is the limit of the configuration and not the
 * limit of a replica.
 *
 * The test starts several **processes** at the same time: the commands of
 * the processes are interleaved by the server, and the count has to be
 * exact anyway. The advisory lock of the window is what serializes them.
 *
 * The test needs a real server: the in-process engine has one connection,
 * so the processes would not compete for it. It runs when
 * `SHUTTLE_TEST_POSTGRES_URL` names a server.
 */
const url = process.env.SHUTTLE_TEST_POSTGRES_URL
const describePostgres = url ? describe : describe.skip

let server: PostgresTestServer | undefined

beforeAll(async () => {
  if (!url) return
  // The schema has to exist before the workers count in it.
  server = await startPostgres()
})

afterAll(async () => {
  await server?.close()
})

describePostgres('the shared state of the replicas in a Postgres server', () => {
  test('the counter of the processes is exact', async () => {
    const key = `test-replica-${Date.now()}`
    const workers = 4
    const perWorker = 25

    const processes = Array.from({ length: workers }, () =>
      Bun.spawn(['bun', 'run', join(import.meta.dir, 'postgres-replica-worker.ts')], {
        env: {
          ...process.env,
          SHUTTLE_TEST_POSTGRES_URL: url!,
          SHUTTLE_TEST_POSTGRES_KEY: key,
          SHUTTLE_TEST_POSTGRES_COUNT: String(perWorker),
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
})
