import { describe, expect, test } from 'bun:test'
import { createRedisClient, isConnectionError, isRedisUrl } from './index'

/**
 * The client of the shared state.
 *
 * The client is the one of the `redis` package, so it is not tied to the
 * runtime of the gateway. The rules that matter for the gateway are the
 * ones of the failure: a command that cannot be sent has to be recognized
 * as a connection failure, so it is retried and the gateway denies the
 * caller instead of waiting.
 */
describe('the url of the shared state', () => {
  test('only the urls of Redis are accepted', () => {
    expect(isRedisUrl('redis://127.0.0.1:6379/0')).toBe(true)
    expect(isRedisUrl('rediss://:secret@redis:6379/0')).toBe(true)
    expect(isRedisUrl('memory://local')).toBe(false)
    expect(isRedisUrl('http://redis:6379')).toBe(false)
    expect(isRedisUrl(undefined)).toBe(false)
  })
})

describe('the failures of the connection', () => {
  test('a client that is closed is a connection failure', () => {
    expect(isConnectionError(new Error('The client is closed'))).toBe(true)
    expect(isConnectionError(new Error('The client is offline'))).toBe(true)
    expect(isConnectionError(new Error('Socket closed unexpectedly'))).toBe(true)
  })

  test('a refused connection is a connection failure', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    })
    expect(isConnectionError(error)).toBe(true)
  })

  test('a closed client of the library is a connection failure', () => {
    const error = Object.assign(new Error('closed'), { code: 'ERR_CLIENT_CLOSED' })
    expect(isConnectionError(error)).toBe(true)
  })

  test('another failure is not a connection failure', () => {
    expect(isConnectionError(new Error('the script failed'))).toBe(false)
    expect(isConnectionError(undefined)).toBe(false)
  })
})

describe('the shapes of the server', () => {
  test('a server, a cluster and a sentinel are all built', async () => {
    const errors: unknown[] = []
    const onError = (error: unknown): void => {
      errors.push(error)
    }
    // The servers are not there: the client keeps trying to connect and
    // reports the failure once. The point of the test is that the url of
    // every shape is understood.
    const server = createRedisClient({ url: 'redis://127.0.0.1:1/0', onError })
    const cluster = createRedisClient({
      url: 'redis://:secret@127.0.0.1:1,127.0.0.1:2/0',
      onError,
    })
    const sentinel = createRedisClient({
      url: 'redis://127.0.0.1:1,127.0.0.1:2/0',
      sentinelMaster: 'the-master',
      onError,
    })
    await server.close()
    await cluster.close()
    await sentinel.close()
    expect(errors.length).toBeGreaterThan(0)
  })
})
