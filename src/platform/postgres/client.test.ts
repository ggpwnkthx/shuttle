import { describe, expect, test } from 'bun:test'
import { createPostgresClient, isConnectionError, isPostgresUrl } from './index'

/**
 * The client of the shared state.
 *
 * The client is the one of the `pg` package, so it is not tied to the
 * runtime of the gateway. The rules that matter for the gateway are the
 * ones of the failure: a command that cannot be sent has to be recognized
 * as a connection failure, so it is retried and the gateway denies the
 * caller instead of waiting.
 */
describe('the url of the shared state', () => {
  test('only the urls of Postgres are accepted', () => {
    expect(isPostgresUrl('postgres://user:secret@postgres:5432/shuttle')).toBe(true)
    expect(isPostgresUrl('postgresql://user:secret@postgres:5432/shuttle')).toBe(true)
    expect(isPostgresUrl('redis://127.0.0.1:6379/0')).toBe(false)
    expect(isPostgresUrl('memory://local')).toBe(false)
    expect(isPostgresUrl(undefined)).toBe(false)
  })
})

describe('the failures of the connection', () => {
  test('a refused connection is a connection failure', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    })
    expect(isConnectionError(error)).toBe(true)
  })

  test('a broken connection is a connection failure', () => {
    expect(isConnectionError(Object.assign(new Error('closed'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('closed'), { code: '08006' }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('closed'), { code: '57P01' }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('full'), { code: '53300' }))).toBe(true)
  })

  test('a pool that cannot hand out a connection is a connection failure', () => {
    expect(isConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true)
  })

  test('another failure is not a connection failure', () => {
    expect(isConnectionError(new Error('the function failed'))).toBe(false)
    expect(isConnectionError(Object.assign(new Error('bad sql'), { code: '42601' }))).toBe(false)
    expect(isConnectionError(undefined)).toBe(false)
  })
})

describe('the client of a server that is not there', () => {
  test('the client is built and it reports the failure once', async () => {
    const errors: unknown[] = []
    const onError = (error: unknown): void => {
      errors.push(error)
    }
    // The server is not there: the client keeps trying to connect and
    // reports the failure. The point of the test is that the client of an
    // unreachable server does not throw and does not hold the process.
    const client = createPostgresClient({ url: 'postgres://127.0.0.1:1/shuttle', onError })
    expect(await client.ping()).toBe(false)
    await client.close()
    expect(errors.length).toBeGreaterThan(0)
  })

  test('a command of a closed client fails right away', async () => {
    const client = createPostgresClient({ url: 'postgres://127.0.0.1:1/shuttle' })
    await client.close()
    await expect(client.query('SELECT 1')).rejects.toThrow(/closed/)
  })
})
