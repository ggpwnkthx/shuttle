import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'

/**
 * The scopes of the rate limits.
 *
 * A scope keyed by the address of the caller cannot tell two tenants behind
 * the same address apart. The scope of a principal is keyed by the subject
 * of the caller, so one tenant cannot spend the budget of the others. The
 * scope of the deployment has no address in it, so it bounds a flood that
 * spreads over many addresses.
 */
describe('the budget of a principal', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX: '2',
        SHUTTLE_RATE_LIMIT_TOTAL_MAX: '0',
      },
      routes: (context) => [
        {
          // A route that needs a credential but no workspace: the budget of
          // the principal is the only limit it carries.
          id: 'signed-site',
          match: { host: 'signed.shuttle.test', path: '/' },
          upstream: context.upstreamA,
          auth: { mode: 'session' },
        },
      ],
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('two tenants behind the same address have separate budgets', async () => {
    const alice = await harness.login({ email: 'alice@shuttle.test' })
    const bob = await harness.login({ email: 'bob@shuttle.test', password: 'bob-password' })
    const call = (cookie: string): Promise<Response> =>
      fetch(`${harness.gatewayUrl}/`, {
        headers: { host: 'signed.shuttle.test', cookie },
      })

    // The budget of Alice is two requests.
    expect((await call(alice.cookie)).status).toBe(200)
    expect((await call(alice.cookie)).status).toBe(200)
    expect((await call(alice.cookie)).status).toBe(429)

    // Bob has his own budget: the address is the same, the subject is not.
    expect((await call(bob.cookie)).status).toBe(200)
  })
})

describe('the budget of the deployment', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        SHUTTLE_RATE_LIMIT_TOTAL_MAX: '3',
        SHUTTLE_RATE_LIMIT_TOTAL_WINDOW_MS: '60000',
      },
    })
  })

  afterAll(async () => {
    await harness.stop()
  })

  test('it bounds every request, whatever the address of the callers', async () => {
    const codes: number[] = []
    for (let index = 0; index < 5; index++) {
      const response = await fetch(`${harness.gatewayUrl}/`, {
        headers: { host: 'public.shuttle.test' },
      })
      codes.push(response.status)
    }
    // The budget is three requests for the whole deployment.
    expect(codes.slice(0, 3)).toEqual([200, 200, 200])
    expect(codes.slice(3)).toEqual([429, 429])
  })
})
