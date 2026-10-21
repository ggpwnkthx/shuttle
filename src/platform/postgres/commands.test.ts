import { describe, expect, test } from 'bun:test'
import { withPostgresRetries, type PostgresCommands } from './commands'

/**
 * The retry of the commands of the shared state.
 *
 * The clients connect in the background: the first command after the start
 * of a process can be sent before the connection is established. The
 * decorator retries the commands that failed for that reason, and only
 * those: a server that is really down has to be reported as such.
 */
describe('the retry of the commands of a shared state', () => {
  test('a command that works is not retried', async () => {
    let calls = 0
    const client: PostgresCommands = {
      query: async <T>() => {
        calls += 1
        return { rows: [] as T[] }
      },
    }
    const wrapped = withPostgresRetries(client)
    await wrapped.query('SELECT 1')
    expect(calls).toBe(1)
  })

  test('a command that failed because the connection was not established is retried', async () => {
    let calls = 0
    const client: PostgresCommands = {
      query: async <T>() => {
        calls += 1
        if (calls < 3) {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        }
        return { rows: [{ ok: 1 }] as T[] }
      },
    }
    const wrapped = withPostgresRetries(client)
    const result = await wrapped.query<{ ok: number }>('SELECT 1')
    expect(result.rows[0]?.ok).toBe(1)
    expect(calls).toBe(3)
  })

  test('a command that failed for another reason is not retried', async () => {
    let calls = 0
    const client: PostgresCommands = {
      query: async () => {
        calls += 1
        throw new Error('the function failed')
      },
    }
    const wrapped = withPostgresRetries(client)
    await expect(wrapped.query('SELECT 1')).rejects.toThrow('the function failed')
    expect(calls).toBe(1)
  })

  test('a command that keeps failing is given up', async () => {
    let calls = 0
    const client: PostgresCommands = {
      query: async () => {
        calls += 1
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      },
    }
    const wrapped = withPostgresRetries(client, 2)
    await expect(wrapped.query('SELECT 1')).rejects.toThrow()
    expect(calls).toBe(2)
  })

  test('the commands the domains do not use keep working', async () => {
    const client = Object.assign(
      {
        query: async <T>() => ({ rows: [] as T[] }),
        close: async (): Promise<void> => undefined,
      },
      { marker: 'kept' }
    )
    const wrapped = withPostgresRetries(client)
    expect(wrapped.marker).toBe('kept')
    await wrapped.close()
  })
})
