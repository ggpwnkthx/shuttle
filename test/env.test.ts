import { describe, expect, test } from 'bun:test'
import { readEnv } from '../src/runtime/env'

/** The environment of a deployment that has everything it needs. */
function productionEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    SHUTTLE_SESSION_SECRET: 'a-secret',
    SHUTTLE_OIDC_ISSUER: 'https://dex.example.com/dex',
    SHUTTLE_OIDC_CLIENT_ID: 'shuttle',
    SHUTTLE_OIDC_CLIENT_SECRET: 'a-client-secret',
    SHUTTLE_OIDC_REDIRECT_URI: 'https://shuttle.example.com/auth/callback',
    SHUTTLE_ACCESS_URL: 'https://access.example.com',
    SHUTTLE_ACCESS_TOKEN: 'an-access-token',
  }
}

describe('the environment', () => {
  test('an empty environment uses the defaults', () => {
    const options = readEnv({ NODE_ENV: 'development' })
    expect(options.gatewayPort).toBe(8080)
    expect(options.configPath).toBe('./config/routes.json')
    expect(options.session.url).toBe('memory://local')
    expect(options.maxBodyBytes).toBe(10 * 1024 * 1024)
  })

  test('a value that cannot be understood stops the gateway', () => {
    // The route table rejects a setting it does not implement, and the
    // environment does the same: a typo in the limit of the request bodies
    // would otherwise remove the limit without a word.
    expect(() =>
      readEnv({
        NODE_ENV: 'development',
        SHUTTLE_GATEWAY_PORT: 'not a number',
      })
    ).toThrow(/SHUTTLE_GATEWAY_PORT/)
  })

  test('an empty value is the value that is not set', () => {
    const options = readEnv({
      NODE_ENV: 'development',
      SHUTTLE_MAX_BODY_BYTES: '',
    })
    expect(options.maxBodyBytes).toBe(10 * 1024 * 1024)
  })

  test('a boolean that cannot be understood stops the gateway', () => {
    expect(() =>
      readEnv({
        NODE_ENV: 'development',
        SHUTTLE_COOKIE_SECURE: 'maybe',
      })
    ).toThrow(/SHUTTLE_COOKIE_SECURE/)
  })

  test('the log level falls back to a level that exists', () => {
    // The level of the log is a nuisance, not a hole.
    const options = readEnv({
      NODE_ENV: 'development',
      SHUTTLE_LOG_LEVEL: 'nonsense',
    })
    expect(options.logLevel).toBe('info')
  })

  test('the limits of the gateway have their defaults', () => {
    const options = readEnv({ NODE_ENV: 'development' })
    expect(options.websocketMaxConnections).toBe(1_000)
    expect(options.rateLimitMax).toBe(0)
    expect(options.loginRateLimitMax).toBe(30)
    expect(options.allowedOrigins).toEqual([])
    expect(options.csrfStrict).toBe(false)
  })

  test('a value that is not allowed stops the gateway', () => {
    expect(() =>
      readEnv({
        NODE_ENV: 'development',
        SHUTTLE_RATE_LIMIT_MAX: '-1',
      })
    ).toThrow(/SHUTTLE_RATE_LIMIT_MAX/)
  })

  test('a list is split at the commas', () => {
    const options = readEnv({
      NODE_ENV: 'development',
      SHUTTLE_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.0.0/16 ,',
      SHUTTLE_OIDC_SCOPES: 'openid,email',
    })
    expect(options.trustedProxies).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
    expect(options.oidc.scopes).toEqual(['openid', 'email'])
  })

  test('a boolean is read from the usual spellings', () => {
    const env = { NODE_ENV: 'development' }
    expect(readEnv({ ...env, SHUTTLE_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true)
    expect(readEnv({ ...env, SHUTTLE_COOKIE_SECURE: 'no' }).cookieSecure).toBe(false)
    expect(readEnv({ ...env, SHUTTLE_OIDC_ALLOW_INSECURE: 'on' }).oidc.allowInsecureIssuer).toBe(true)
  })

  test('a production environment is safe by default', () => {
    const options = readEnv(productionEnv())
    // The cookies of a production deployment are secure.
    expect(options.cookieSecure).toBe(true)
    // An identity provider that is not served over https is refused.
    expect(options.oidc.allowInsecureIssuer).toBe(false)
  })

  test('a development environment allows an insecure identity provider', () => {
    const options = readEnv({ NODE_ENV: 'development' })
    expect(options.oidc.allowInsecureIssuer).toBe(true)
    expect(options.cookieSecure).toBe(false)
  })

  test('the session secret is generated when it is not configured', () => {
    const first = readEnv({ NODE_ENV: 'development' }).sessionSecret
    const second = readEnv({ NODE_ENV: 'development' }).sessionSecret
    expect(first).toHaveLength(64)
    expect(first).not.toBe(second)
  })

  test('a production environment refuses to start without a session secret', () => {
    // The secret signs the state cookie of the login flow. A secret that is
    // generated per process is only valid on the replica that generated it,
    // so a deployment with more than one replica would fail the login at
    // random. The gateway refuses to start instead.
    expect(() => readEnv({ NODE_ENV: 'production' })).toThrow(/SHUTTLE_SESSION_SECRET/)
  })

  test('a production environment uses the configured session secret', () => {
    const options = readEnv(productionEnv())
    expect(options.sessionSecret).toBe('a-secret')
  })

  test('a production environment names its identity provider', () => {
    // The development default points at the fixture of the repository. A
    // deployment that forgets to configure the issuer would talk to nobody,
    // so the gateway refuses to start instead.
    expect(() =>
      readEnv({ NODE_ENV: 'production', SHUTTLE_SESSION_SECRET: 'a-secret' })
    ).toThrow(/SHUTTLE_OIDC_ISSUER/)
    expect(() =>
      readEnv({
        ...productionEnv(),
        SHUTTLE_OIDC_ISSUER: 'https://dex.example.com/dex',
        SHUTTLE_OIDC_CLIENT_ID: undefined,
      })
    ).toThrow(/SHUTTLE_OIDC_CLIENT_ID/)
    expect(() =>
      readEnv({
        ...productionEnv(),
        SHUTTLE_OIDC_ISSUER: 'https://dex.example.com/dex',
        SHUTTLE_OIDC_CLIENT_ID: 'shuttle',
        SHUTTLE_OIDC_REDIRECT_URI: undefined,
      })
    ).toThrow(/SHUTTLE_OIDC_REDIRECT_URI/)
  })

  test('a production environment authenticates against the access service', () => {
    // The access service decides who may use a workspace. A deployment that
    // forgets to configure it would deny every caller (or allow every
    // caller, depending on the answer of the fixture), so the gateway
    // refuses to start instead.
    expect(() =>
      readEnv({
        ...productionEnv(),
        SHUTTLE_ACCESS_URL: undefined,
      })
    ).toThrow(/SHUTTLE_ACCESS_URL/)
    expect(() =>
      readEnv({
        ...productionEnv(),
        SHUTTLE_ACCESS_URL: 'https://access.example.com',
        SHUTTLE_ACCESS_TOKEN: undefined,
      })
    ).toThrow(/SHUTTLE_ACCESS_TOKEN/)
  })

  test('a production environment may allow an anonymous access service', () => {
    // Only for a deployment where the access service authenticates the
    // gateway by other means, and only when it is asked for explicitly.
    const options = readEnv({
      ...productionEnv(),
      SHUTTLE_ACCESS_URL: 'https://access.example.com',
      SHUTTLE_ACCESS_TOKEN: undefined,
      SHUTTLE_ACCESS_ALLOW_ANONYMOUS: 'true',
    })
    expect(options.access.token).toBeUndefined()
  })

  test('a production environment needs the secret of the identity provider', () => {
    expect(() =>
      readEnv({
        ...productionEnv(),
        SHUTTLE_OIDC_CLIENT_SECRET: undefined,
      })
    ).toThrow(/SHUTTLE_OIDC_CLIENT_SECRET/)
    const options = readEnv({
      ...productionEnv(),
      SHUTTLE_OIDC_CLIENT_SECRET: undefined,
      SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT: 'true',
    })
    expect(options.oidc.clientSecret).toBeUndefined()
  })
})
