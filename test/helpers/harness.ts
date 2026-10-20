import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculatePKCECodeChallenge, randomPKCECodeVerifier } from 'openid-client'
import { randomToken } from '../../src/auth/crypto'
import { createRuntime, type Runtime } from '../../src/runtime/runtime'
import { defaultSessionRuntimeOptions } from '../../src/runtime/env'
import { startServers, type StartedServers } from '../../src/server'
import {
  startAccessService,
  type AccessPolicy,
  type StartedAccessService,
} from '../../services/access-fixture'
import { startOidcProvider, type StartedOidcProvider } from '../../services/oidc-provider'
import { startUpstream, type StartedUpstream } from '../../services/upstream'

export const METRICS_TOKEN = 'test-metrics-token'

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'

export interface HarnessOptions {
  policy?: AccessPolicy
  /** Extra or replacement routes. Receives the upstream URLs. */
  routes?: (context: { upstreamA: string; upstreamB: string }) => unknown[]
  /** Replace the whole configuration. */
  config?: (context: { upstreamA: string; upstreamB: string }) => unknown
  accessUnavailable?: boolean
  /** CIDR ranges whose forwarding headers are trusted. */
  trustedProxies?: string[]
  /** The number of requests a single caller may make in a window. */
  rateLimitMax?: number
  /** The number of login attempts a single caller may make in a window. */
  loginRateLimitMax?: number
  /** The number of websocket connections that may be open at the same time. */
  websocketMaxConnections?: number
  /** How often the gateway pings the open websockets, in milliseconds. */
  websocketPingIntervalMs?: number
  /** How long a websocket may stay silent before it is closed. */
  websocketPongTimeoutMs?: number
  /** The origins that are allowed to make requests to the gateway. */
  allowedOrigins?: string[]
  /** Refuse the navigations from another site as well. */
  csrfStrict?: boolean
}

export interface Harness {
  runtime: Runtime
  servers: StartedServers
  idp: StartedOidcProvider
  access: StartedAccessService
  upstreamA: StartedUpstream
  upstreamB: StartedUpstream
  gatewayUrl: string
  configPath: string
  /** The bearer token that guards the metrics endpoint. */
  metricsToken: string
  /** Rewrites the configuration file on disk. */
  writeConfig: (config: unknown) => Promise<void>
  /** Performs the full browser login flow and returns the session cookie. */
  login: (options?: LoginOptions) => Promise<LoginResult>
  /**
   * Performs the identity provider part of the browser flow and returns the
   * callback url of the provider.
   */
  signInAtProvider: (authorizeUrl: string, options?: LoginOptions) => Promise<string>
  /** Requests a bearer token for API clients. */
  token: (options?: { email?: string; subject?: string }) => Promise<string>
  stop: () => Promise<void>
}

export interface LoginOptions {
  email?: string
  password?: string
  redirect?: string
}

export interface LoginResult {
  cookie: string
  sessionCookie: string
  idToken?: string
  /** The identity provider callback URL that was used (single use). */
  callbackUrl?: string
  /** The cookie jar that holds the session and the login state cookies. */
  jar?: CookieJar
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const port = server.port ?? 0
  await server.stop(true)
  return port
}

/** A very small cookie jar so that the tests can follow the browser flow. */
export class CookieJar {
  #cookies = new Map<string, string>()

  capture(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookies = headers.getSetCookie?.() ?? []
    for (const cookie of cookies) {
      const [pair] = cookie.split(';')
      if (!pair) continue
      const index = pair.indexOf('=')
      if (index === -1) continue
      this.#cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  header(): string {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }
}

export function defaultRoutes(context: { upstreamA: string; upstreamB: string }): unknown[] {
  return [
    {
      id: 'public-site',
      match: { host: 'public.shuttle.test', path: '/' },
      upstream: context.upstreamA,
      auth: { mode: 'none' },
    },
    {
      id: 'workspace-api',
      match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
      upstream: context.upstreamB,
      auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
      websocket: true,
    },
    {
      id: 'workspace-assets',
      match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/assets/' },
      upstream: context.upstreamB,
      auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
    },
  ]
}

export function defaultConfig(
  context: { upstreamA: string; upstreamB: string },
  trustedProxies: string[] = ['127.0.0.1/32']
): unknown {
  return {
    version: 1,
    defaults: { auth: { mode: 'none' }, maxBodyBytes: 1024 * 1024 },
    trustedProxies,
    routes: defaultRoutes(context),
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // The port is known before the identity provider starts, so it can
  // register the callback url of the gateway.
  const gatewayPort = await freePort()
  const gatewayUrl = `http://localhost:${gatewayPort}`

  const idp = await startOidcProvider({
    redirectUris: [`${gatewayUrl}/auth/callback`],
  })
  const access = await startAccessService({
    policy: options.policy,
    unavailable: options.accessUnavailable,
  })
  const upstreamA = await startUpstream({ name: 'upstream-a' })
  const upstreamB = await startUpstream({ name: 'upstream-b' })

  const directory = await mkdtemp(join(tmpdir(), 'shuttle-test-'))
  const configPath = join(directory, 'routes.json')

  const buildConfig = (): unknown =>
    options.config
      ? options.config({ upstreamA: upstreamA.url, upstreamB: upstreamB.url })
      : defaultConfig(
          { upstreamA: upstreamA.url, upstreamB: upstreamB.url },
          options.trustedProxies ?? ['127.0.0.1/32']
        )

  const routes =
    options.routes?.({ upstreamA: upstreamA.url, upstreamB: upstreamB.url }) ??
    defaultRoutes({ upstreamA: upstreamA.url, upstreamB: upstreamB.url })

  const config = buildConfig()
  if (Array.isArray((config as { routes?: unknown[] }).routes)) {
    ;(config as { routes: unknown[] }).routes = routes
  }
  await writeFile(configPath, JSON.stringify(config, null, 2))

  const runtime = createRuntime({
    configPath,
    gatewayPort,
    gatewayHost: '127.0.0.1',
    oidc: {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      redirectUri: `${gatewayUrl}/auth/callback`,
      scopes: ['openid', 'profile', 'email'],
      // The development provider is served over plain http.
      allowInsecureIssuer: true,
    },
    access: { baseUrl: access.url, timeoutMs: 2000, cacheTtlMs: 0 },
    sessionSecret: 'test-session-secret',
    session: defaultSessionRuntimeOptions(),
    sharedStateKeyPrefix: 'shuttle',
    cookieSecure: false,
    logLevel: 'error',
    metricsToken: METRICS_TOKEN,
    maxBodyBytes: 1024 * 1024,
    websocketMaxBufferedBytes: 64 * 1024,
    websocketMaxBufferedMessages: 20,
    websocketMaxPayloadBytes: 16 * 1024 * 1024,
    websocketBackpressureLimitBytes: 1024 * 1024,
    // The keepalive is off in the tests: it would close the connections of
    // the tests that do not answer a ping.
    websocketPingIntervalMs: options.websocketPingIntervalMs ?? 0,
    websocketPongTimeoutMs: options.websocketPongTimeoutMs ?? 90_000,
    websocketIdleTimeoutSeconds: 120,
    websocketMaxConnections: options.websocketMaxConnections ?? 100,
    websocketHandshakeTimeoutMs: 5_000,
    rateLimitMax: options.rateLimitMax ?? 0,
    rateLimitWindowMs: 60_000,
    // The tests log in a lot, the limiter of the logins would get in the way.
    loginRateLimitMax: options.loginRateLimitMax ?? 1_000,
    loginRateLimitWindowMs: 60_000,
    allowedOrigins: options.allowedOrigins ?? [],
    csrfStrict: options.csrfStrict ?? false,
    trustedProxies: [],
    externalProto: 'http',
    shutdownTimeoutMs: 5_000,
  })

  const loaded = await runtime.config.reload()
  if (!loaded.ok) {
    throw new Error(`the test configuration is invalid: ${loaded.error.message}`)
  }

  const servers = await startServers(runtime)

  const writeConfig = async (next: unknown): Promise<void> => {
    await writeFile(configPath, JSON.stringify(next, null, 2))
  }

  /**
   * Drives the identity provider: the browser is sent to the provider, the
   * provider asks for the account and answers with a callback url.
   */
  const signInAtProvider = async (
    authorizeUrl: string,
    loginOptions: LoginOptions = {}
  ): Promise<string> => {
    const email = loginOptions.email ?? 'alice@shuttle.test'
    const password = loginOptions.password ?? 'alice-password'
    const jar = new CookieJar()
    // The provider answers with relative urls, the gateway with absolute ones.
    const resolve = (value: string): string =>
      value.startsWith('/') ? new URL(value, idp.url).toString() : value
    let location = resolve(authorizeUrl)

    for (let hop = 0; hop < 10; hop++) {
      if (location.includes('code=')) return location
      if (location.includes('/interaction/')) {
        const submitted = await fetch(location, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            // The provider keeps the interaction in a cookie.
            ...(jar.header() ? { cookie: jar.header() } : {}),
          },
          body: new URLSearchParams({ email, password }),
          redirect: 'manual',
        })
        const next = submitted.headers.get('location')
        if (!next) {
          throw new Error(`the identity provider rejected the credentials (${submitted.status})`)
        }
        location = resolve(next)
        continue
      }
      const response = await fetch(location, {
        redirect: 'manual',
        headers: jar.header() ? { cookie: jar.header() } : undefined,
      })
      jar.capture(response)
      const next = response.headers.get('location')
      if (!next) {
        throw new Error(`the identity provider stopped the flow at ${location} (${response.status})`)
      }
      location = resolve(next)
    }
    throw new Error('the identity provider did not return an authorization code')
  }

  const login = async (loginOptions: LoginOptions = {}): Promise<LoginResult> => {
    const redirect = loginOptions.redirect ?? '/'
    const jar = new CookieJar()

    const start = await fetch(
      `${gatewayUrl}/auth/login?redirect=${encodeURIComponent(redirect)}`,
      { redirect: 'manual' }
    )
    jar.capture(start)
    const authorizeUrl = start.headers.get('location')
    if (!authorizeUrl) throw new Error('the gateway did not return a redirect to the identity provider')

    const callbackUrl = await signInAtProvider(authorizeUrl, loginOptions)

    const callback = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: jar.header() ? { cookie: jar.header() } : undefined,
    })
    jar.capture(callback)
    const sessionCookie = jar.get('shuttle_session')
    if (!sessionCookie) {
      throw new Error(`the login did not create a session: ${callback.status}`)
    }
    return {
      cookie: `shuttle_session=${sessionCookie}`,
      sessionCookie: `shuttle_session=${sessionCookie}`,
      callbackUrl,
      jar,
    }
  }

  /**
   * Requests a token for an API client.
   *
   * The development provider issues the id token of the account; the gateway
   * validates it like every other JWT of the provider.
   */
  const token = async (tokenOptions: { email?: string; subject?: string } = {}): Promise<string> => {
    const email = tokenOptions.email ?? 'alice@shuttle.test'
    const subject = tokenOptions.subject ?? 'user-alice'
    const account =
      idp.users.find((user) => user.sub === subject) ??
      idp.users.find((user) => user.email === email)
    if (!account) throw new Error(`the identity provider does not know ${email}`)

    const verifier = randomPKCECodeVerifier()
    const challenge = await calculatePKCECodeChallenge(verifier)
    const redirectUri = `${gatewayUrl}/auth/callback`
    const authorizeUrl =
      `${idp.url}/auth?client_id=${encodeURIComponent(idp.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      '&response_type=code&scope=openid%20profile%20email' +
      `&state=${randomToken(12)}&nonce=${randomToken(12)}` +
      `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`

    const callbackUrl = await signInAtProvider(authorizeUrl, {
      email: account.email,
      password: account.password,
    })
    const code = new URL(callbackUrl).searchParams.get('code') ?? ''

    const response = await fetch(`${idp.url}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${idp.clientId}:${idp.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
    const body = (await response.json()) as { id_token?: string; error?: string }
    if (!body.id_token) {
      throw new Error(`unable to obtain a token: ${body.error ?? 'unknown error'}`)
    }
    return body.id_token
  }

  const stop = async (): Promise<void> => {
    await servers.stop()
    await Promise.all([idp.stop(), access.stop(), upstreamA.stop(), upstreamB.stop()])
    await rm(directory, { recursive: true, force: true })
  }

  return {
    runtime,
    servers,
    idp,
    access,
    upstreamA,
    upstreamB,
    gatewayUrl,
    configPath,
    metricsToken: METRICS_TOKEN,
    writeConfig,
    login,
    signInAtProvider,
    token,
    stop,
  }
}
