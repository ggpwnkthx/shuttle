import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnv } from '../../src/runtime/env'
import { createRuntime, type GatewayRuntime } from '../../src/runtime/composition'
import {
  startAccessService,
  type AccessPolicy,
  type StartedAccessService,
} from '../../services/access-fixture'
import { startOidcProvider, type StartedOidcProvider } from '../../services/oidc-provider'
import { freePort as findFreePort } from '../../services/port'
import { startUpstream, type StartedUpstream } from '../../services/upstream'

/**
 * The harness of the contract tests.
 *
 * It starts the real gateway with the fixtures around it: the identity
 * provider, the access service and two upstreams. The tests speak to the
 * gateway over a socket, exactly like a caller does.
 */

export const METRICS_TOKEN = 'test-metrics-token'
export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

export interface HarnessOptions {
  policy?: AccessPolicy
  /** The routes of the configuration. */
  routes?: (context: { upstreamA: string; upstreamB: string }) => unknown[]
  /** The whole configuration. */
  config?: (context: { upstreamA: string; upstreamB: string }) => unknown
  /** The ranges whose forwarding headers are trusted. */
  trustedProxies?: string[]
  /** The requests a caller may make to one route in a window. */
  rateLimitMax?: number
  /** The requests a caller may make over all the routes in a window. */
  rateLimitGlobalMax?: number
  /** The login attempts a caller may make in a window. */
  loginRateLimitMax?: number
  /** The origins that are allowed in addition to the origin of the gateway. */
  allowedOrigins?: string[]
  /** Refuse the navigations from another site as well. */
  csrfStrict?: boolean
  /** The budgets of the routes. */
  timeouts?: Record<string, unknown>
  /** The limit of the body of the requests. */
  maxBodyBytes?: number
  /** The environment of the gateway. */
  env?: Record<string, string>
  /** The configuration of the tests is invalid: the gateway starts without one. */
  expectInvalidConfig?: boolean
}

export interface Harness {
  runtime: GatewayRuntime
  idp: StartedOidcProvider
  access: StartedAccessService
  upstreamA: StartedUpstream
  upstreamB: StartedUpstream
  gatewayUrl: string
  configPath: string
  /** Rewrites the configuration file on disk. */
  writeConfig: (config: unknown) => Promise<void>
  /** Performs the full browser login and returns the cookie of the session. */
  login: (options?: LoginOptions) => Promise<LoginResult>
  /** Requests a bearer token for an api client. */
  token: (options?: { email?: string; subject?: string }) => Promise<string>
  stop: () => Promise<void>
}

export interface LoginOptions {
  email?: string
  password?: string
  redirect?: string
}

export interface LoginResult {
  /** The value of the cookie of the session. */
  sessionCookie: string
  /** The header `Cookie` a caller sends. */
  cookie: string
  /** The jar that holds the cookies of the browser. */
  jar: CookieJar
}

/** A very small cookie jar, so that the tests can follow the browser flow. */
class CookieJar {
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

/** Finds a free port for the gateway.
 *
 * The port comes from the range of the tests, not from the range of the
 * ephemeral ports of the kernel: the fixtures of the tests bind the port
 * zero, and the kernel may hand out a port that the harness has reserved
 * and released in the meantime.
 */
async function freePort(): Promise<number> {
  return await findFreePort()
}

/** The routes of the tests. */
function defaultRoutes(context: { upstreamA: string; upstreamB: string }): unknown[] {
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
    },
    {
      id: 'workspace-assets',
      match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/assets/' },
      upstream: context.upstreamB,
      auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
    },
    {
      id: 'workspace-socket',
      match: { host: 'socket.shuttle.test', path: '/socket/' },
      upstream: context.upstreamB,
      auth: { mode: 'any' },
      websocket: true,
    },
    {
      id: 'public-socket',
      // The websocket client of a browser cannot set the host of the
      // request, so the route of the tests matches every host.
      match: { host: '*', path: '/socket/' },
      upstream: context.upstreamB,
      auth: { mode: 'none' },
      websocket: true,
    },
  ]
}

/** The configuration of the tests. */
function defaultConfig(
  context: { upstreamA: string; upstreamB: string },
  options: { trustedProxies?: string[]; timeouts?: Record<string, unknown> } = {}
): unknown {
  return {
    version: 1,
    defaults: {
      auth: { mode: 'none' },
      timeouts: options.timeouts ?? { responseMs: 5000, firstByteMs: 30000, bodyMs: 300000 },
      maxBodyBytes: 1024 * 1024,
    },
    trustedProxies: options.trustedProxies ?? ['127.0.0.1/32'],
    routes: defaultRoutes(context),
  }
}

/** Starts the gateway with the fixtures around it. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const gatewayPort = await freePort()
  const gatewayUrl = `http://localhost:${gatewayPort}`

  const idp = await startOidcProvider({
    redirectUris: [`${gatewayUrl}/auth/callback`],
  })
  const access = await startAccessService({ policy: options.policy })
  const upstreamA = await startUpstream({ name: 'upstream-a' })
  const upstreamB = await startUpstream({ name: 'upstream-b' })

  const directory = await mkdtemp(join(tmpdir(), 'shuttle-contract-'))
  const configPath = join(directory, 'routes.json')

  const context = { upstreamA: upstreamA.url, upstreamB: upstreamB.url }
  const config = options.config
    ? options.config(context)
    : defaultConfig(context, {
        trustedProxies: options.trustedProxies ?? ['127.0.0.1/32'],
        timeouts: options.timeouts,
      })
  if (Array.isArray((config as { routes?: unknown[] }).routes)) {
    ;(config as { routes: unknown[] }).routes =
      options.routes?.(context) ?? (config as { routes: unknown[] }).routes
  }
  await writeFile(configPath, JSON.stringify(config, null, 2))

  const settings = readEnv({
    SHUTTLE_CONFIG: configPath,
    SHUTTLE_GATEWAY_HOST: '127.0.0.1',
    SHUTTLE_GATEWAY_PORT: String(gatewayPort),
    SHUTTLE_OIDC_ISSUER: idp.issuer,
    SHUTTLE_OIDC_CLIENT_ID: idp.clientId,
    SHUTTLE_OIDC_CLIENT_SECRET: idp.clientSecret,
    SHUTTLE_OIDC_REDIRECT_URI: `${gatewayUrl}/auth/callback`,
    SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
    SHUTTLE_ACCESS_URL: access.url,
    SHUTTLE_SESSION_SECRET: 'test-session-secret',
    SHUTTLE_SESSION_URL: 'memory://local',
    SHUTTLE_SESSION_TTL_MS: '600000',
    SHUTTLE_SESSION_MAX_AGE_MS: '1200000',
    SHUTTLE_SESSION_TOUCH_INTERVAL_MS: '1000',
    SHUTTLE_COOKIE_SECURE: 'false',
    SHUTTLE_LOG_LEVEL: 'error',
    SHUTTLE_SHUTDOWN_TIMEOUT_MS: '2000',
    SHUTTLE_METRICS_TOKEN: METRICS_TOKEN,
    SHUTTLE_MAX_BODY_BYTES: String(options.maxBodyBytes ?? 1024 * 1024),
    SHUTTLE_RATE_LIMIT_MAX: String(options.rateLimitMax ?? 0),
    SHUTTLE_RATE_LIMIT_WINDOW_MS: '60000',
    SHUTTLE_RATE_LIMIT_GLOBAL_MAX: String(options.rateLimitGlobalMax ?? 0),
    SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS: '60000',
    SHUTTLE_LOGIN_RATE_LIMIT_MAX: String(options.loginRateLimitMax ?? 1000),
    SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
    SHUTTLE_ALLOWED_ORIGINS: (options.allowedOrigins ?? []).join(','),
    SHUTTLE_CSRF_STRICT: options.csrfStrict ? 'true' : 'false',
    SHUTTLE_TRUSTED_PROXIES: (options.trustedProxies ?? []).join(','),
    ...options.env,
  })

  const runtime = await createRuntime(settings)
  const loaded = runtime.config.apply(JSON.parse(await readFile(configPath, 'utf8')))
  if (!loaded.ok && !options.expectInvalidConfig) {
    throw new Error(`the configuration of the test is invalid: ${loaded.error.message}`)
  }

  const writeConfig = async (next: unknown): Promise<void> => {
    await writeFile(configPath, JSON.stringify(next, null, 2))
  }

  /** Drives the identity provider: the browser is sent to the provider. */
  const signInAtProvider = async (
    authorizeUrl: string,
    loginOptions: LoginOptions = {}
  ): Promise<string> => {
    const email = loginOptions.email ?? 'alice@shuttle.test'
    const password = loginOptions.password ?? 'alice-password'
    const jar = new CookieJar()
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
        throw new Error(
          `the identity provider stopped the flow at ${location} (${response.status})`
        )
      }
      location = resolve(next)
    }
    throw new Error('the identity provider did not return an authorization code')
  }

  const login = async (loginOptions: LoginOptions = {}): Promise<LoginResult> => {
    const redirect = loginOptions.redirect ?? '/'
    const jar = new CookieJar()

    const start = await fetch(`${gatewayUrl}/auth/login?redirect=${encodeURIComponent(redirect)}`, {
      redirect: 'manual',
    })
    jar.capture(start)
    const authorizeUrl = start.headers.get('location')
    if (!authorizeUrl) {
      throw new Error('the gateway did not return a redirect to the identity provider')
    }

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
      sessionCookie,
      cookie: `shuttle_session=${sessionCookie}`,
      jar,
    }
  }

  const token = async (
    tokenOptions: { email?: string; subject?: string } = {}
  ): Promise<string> => {
    const email = tokenOptions.email ?? 'alice@shuttle.test'
    const subject = tokenOptions.subject ?? 'user-alice'
    const account =
      idp.users.find((user) => user.sub === subject) ??
      idp.users.find((user) => user.email === email)
    if (!account) throw new Error(`the identity provider does not know ${email}`)

    // The credential of an api client is an access token, and not the id
    // token of a browser: the gateway refuses a bearer token that carries
    // a nonce, and the id token of the gateway always carries one.
    return await idp.mintAccessToken({ subject: account.sub, email: account.email })
  }

  const stop = async (): Promise<void> => {
    await runtime.listener.stop(true)
    await runtime.close()
    await Promise.all([idp.stop(), access.stop(), upstreamA.stop(), upstreamB.stop()])
    await rm(directory, { recursive: true, force: true })
  }

  return {
    runtime,
    idp,
    access,
    upstreamA,
    upstreamB,
    gatewayUrl,
    configPath,
    writeConfig,
    login,
    token,
    stop,
  }
}
