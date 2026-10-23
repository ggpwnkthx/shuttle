/**
 * The process of the control plane.
 *
 * The control plane is a separate process: it reads its own environment, it
 * opens the shared state it acts on and it starts its own listener. The
 * test starts the runtime the way the deployment does and speaks to it
 * over a socket, exactly like an operator does.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlRuntime, type ControlRuntime } from '../../src/runtime/control'
import { readControlEnv, type ControlSettings } from '../../src/runtime/env'

/** The url of the shared state the control plane acts on. */
const stateUrl = process.env.SHUTTLE_TEST_REDIS_URL ?? process.env.SHUTTLE_TEST_POSTGRES_URL

/** The token of the operator of the tests. */
const TOKEN = 'a-token-of-the-deployment-0001'

let runtime: ControlRuntime | undefined
let directory: string | undefined

/** The settings of the control plane of the tests. */
function settings(tokensFile: string): ControlSettings {
  return readControlEnv({
    NODE_ENV: 'development',
    SHUTTLE_CONTROL_HOST: '127.0.0.1',
    SHUTTLE_CONTROL_PORT: '0',
    SHUTTLE_CONTROL_TOKENS_FILE: tokensFile,
    SHUTTLE_CONTROL_STATE_URL: stateUrl!,
    SHUTTLE_CONTROL_KEY_PREFIX: `control-test-${Date.now()}`,
  })
}

describe.skipIf(!stateUrl)('the process of the control plane', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shuttle-control-'))
    const tokensFile = join(directory, 'tokens.json')
    await writeFile(
      tokensFile,
      JSON.stringify({ [TOKEN]: { operator: 'the-operator', scope: 'config' } }),
      'utf8'
    )
    runtime = await createControlRuntime(settings(tokensFile))
  })

  afterAll(async () => {
    await runtime?.close()
  })

  test('the listener answers without a token', async () => {
    const health = await fetch(`http://127.0.0.1:${runtime!.listener.port}/healthz`)
    expect(health.status).toBe(200)
    const body = (await health.json()) as { service: string }
    expect(body.service).toBe('shuttle-control')
  })

  test('the endpoints need a token', async () => {
    const response = await fetch(`http://127.0.0.1:${runtime!.listener.port}/v1/config`)
    expect(response.status).toBe(401)
  })

  test('the endpoints answer with a token', async () => {
    const response = await fetch(`http://127.0.0.1:${runtime!.listener.port}/v1/config`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { revision: number | null }
    expect(body.revision === null || typeof body.revision === 'number').toBe(true)
  })

  test('a map of tokens that cannot be read stops the process', async () => {
    const tokensFile = join(directory!, 'broken.json')
    await writeFile(tokensFile, 'not json', 'utf8')
    let refused = false
    try {
      await createControlRuntime(settings(tokensFile))
    } catch (error) {
      refused = true
      expect(String(error)).toContain('tokens')
    }
    expect(refused).toBe(true)
  })

  test('a token that is the secret of the state stops the process', async () => {
    const tokensFile = join(directory!, 'secret.json')
    const secret = 'the-password-of-the-state'
    await writeFile(
      tokensFile,
      JSON.stringify({ [secret]: { operator: 'the-operator', scope: 'read' } }),
      'utf8'
    )
    let refused = false
    try {
      const settings = readControlEnv({
        NODE_ENV: 'development',
        SHUTTLE_CONTROL_TOKENS_FILE: tokensFile,
        SHUTTLE_CONTROL_STATE_URL: `redis://:${secret}@127.0.0.1:6379/0`,
      })
      await createControlRuntime(settings)
    } catch (error) {
      refused = true
      expect(String(error)).toContain('used twice')
    }
    expect(refused).toBe(true)
  })

  test('the environment of the control plane needs a state', () => {
    let refused = false
    try {
      readControlEnv({
        SHUTTLE_CONTROL_TOKENS: JSON.stringify({ [TOKEN]: { operator: 'o', scope: 'read' } }),
        SHUTTLE_CONTROL_STATE_URL: 'memory://local',
      })
    } catch (error) {
      refused = true
      expect(String(error)).toContain('SHUTTLE_CONTROL_STATE_URL')
    }
    expect(refused).toBe(true)
  })

  test('the environment of the control plane needs a map of tokens', () => {
    let refused = false
    try {
      readControlEnv({ SHUTTLE_CONTROL_STATE_URL: stateUrl! })
    } catch (error) {
      refused = true
      expect(String(error)).toContain('SHUTTLE_CONTROL_TOKENS')
    }
    expect(refused).toBe(true)
  })
})
