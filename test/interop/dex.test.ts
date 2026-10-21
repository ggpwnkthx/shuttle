import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The interoperability with a real identity provider.
 *
 * The tests of the project run against the fixture of `services/`, and the
 * fixture shares the assumptions of the gateway: it is written by the same
 * hand. A deployment runs a provider that was written by somebody else, so
 * the flow is proven against one of them as well.
 *
 * The test is skipped when the environment does not name a provider: a
 * developer without one still runs the rest of the suite.
 *
 * ```bash
 * SHUTTLE_TEST_DEX_ISSUER=http://localhost:5556/dex \
 * SHUTTLE_TEST_DEX_CLIENT_ID=shuttle-ci \
 * SHUTTLE_TEST_DEX_CLIENT_SECRET=shuttle-ci-secret \
 * bun test test/interop
 * ```
 */
const issuer = process.env.SHUTTLE_TEST_DEX_ISSUER

describe.skipIf(!issuer)('the interoperability with a real identity provider', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness({
      // The port is fixed: the provider of the deployment is configured
      // with the exact uri of the callback.
      gatewayPort: 18080,
      issuer: {
        issuer: issuer!,
        clientId: process.env.SHUTTLE_TEST_DEX_CLIENT_ID ?? 'shuttle-ci',
        clientSecret: process.env.SHUTTLE_TEST_DEX_CLIENT_SECRET ?? 'shuttle-ci-secret',
      },
    })
  })

  afterAll(async () => {
    await harness?.stop()
  })

  test('the discovery of the provider is read', async () => {
    const response = await fetch(`${issuer!}/.well-known/openid-configuration`)
    expect(response.status).toBe(200)
    const document = (await response.json()) as { issuer: string; authorization_endpoint: string }
    expect(document.issuer).toBe(issuer!)
    expect(document.authorization_endpoint).toBeString()
  })

  test('a caller signs in with the provider of the deployment', async () => {
    const login = await harness.login({
      email: process.env.SHUTTLE_TEST_DEX_EMAIL ?? 'alice@shuttle.test',
      password: process.env.SHUTTLE_TEST_DEX_PASSWORD ?? 'alice-password',
    })
    expect(login.sessionCookie).toBeString()

    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: { host: 'api.shuttle.test', cookie: login.cookie },
    })
    expect(response.status).toBe(200)
  })
})
