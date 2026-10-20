#!/usr/bin/env bun
/**
 * The development identity provider.
 *
 * The OpenID Connect protocol is implemented by the `oidc-provider` package,
 * this module only configures it, keeps the fixture accounts and renders the
 * sign in page of the provider. It is a development fixture and is never used
 * in a deployment.
 *
 * The module is used in two ways:
 *
 * - started directly (`bun run services/oidc-provider.ts`), for the compose
 *   stack and for a standalone run
 * - imported (`startOidcProvider`), for the development runner and the tests
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import Provider from 'oidc-provider'
import { exportJWK, generateKeyPair, type JWK } from 'jose'
import { assertFixtureAllowed, FixtureInProductionError } from './fixture-guard'

export interface OidcUser {
  sub: string
  email: string
  name: string
  roles: string[]
  password: string
}

export interface OidcProviderOptions {
  port?: number
  /** Public issuer url; defaults to `http://localhost:<port>`. */
  issuer?: string
  users?: OidcUser[]
  clientId?: string
  clientSecret?: string
  /** Redirect uris the client is allowed to use. */
  redirectUris?: string[]
  logger?: (message: string) => void
}

export interface StartedOidcProvider {
  url: string
  issuer: string
  clientId: string
  clientSecret: string
  users: OidcUser[]
  /**
   * The private key of the provider, as a JWK.
   *
   * The tests mint tokens with it, to check what the gateway does with a
   * token that is expired, that has the wrong audience or that has no
   * subject.
   */
  privateJwk: JWK
  /** Replaces the signing key of the provider, as a rotation does. */
  rotateKeys: () => Promise<void>
  stop: () => Promise<void>
}

const DEFAULT_USERS: OidcUser[] = [
  {
    sub: 'user-alice',
    email: 'alice@shuttle.test',
    name: 'Alice Example',
    roles: ['admin', 'member'],
    password: 'alice-password',
  },
  {
    sub: 'user-bob',
    email: 'bob@shuttle.test',
    name: 'Bob Example',
    roles: ['member'],
    password: 'bob-password',
  },
]

const DEFAULT_REDIRECT_URIS = ['http://localhost:8080/auth/callback']

/** Escapes the characters that have a meaning in markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Renders the sign in page of the development identity provider.
 *
 * Every value that is interpolated is escaped, so an account name can never
 * become markup.
 */
function renderLoginPage(accounts: OidcUser[], error?: string): string {
  const options = accounts
    .map(
      (account) =>
        `<option value="${escapeHtml(account.email)}">${escapeHtml(account.email)} — ${escapeHtml(account.roles.join(', '))}</option>`
    )
    .join('')
  const addresses = accounts.map((account) => escapeHtml(account.email)).join(', ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shuttle identity provider</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:4rem auto;max-width:24rem;color:#111}
label{display:block;margin:.75rem 0 .25rem}input,select{width:100%;padding:.45rem;box-sizing:border-box}
button{margin-top:1rem;padding:.5rem 1rem}</style></head>
<body><h1>Sign in</h1>
${error ? `<p style="color:#b91c1c">${escapeHtml(error)}</p>` : ''}
<form method="post">
<label for="email">Account</label>
<select id="email" name="email">${options}</select>
<label for="password">Password</label>
<input id="password" name="password" type="password" />
<button type="submit">Sign in</button>
</form>
<p><small>Development identity provider (oidc-provider). Accounts: ${addresses}</small></p>
</body></html>`
}

/** Reads an `application/x-www-form-urlencoded` body. */
async function readForm(request: AsyncIterable<Buffer>): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** Compares two secrets in constant time. */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Finds a free port, so the issuer can be known before the provider starts. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => {
        if (port === 0) reject(new Error('unable to find a free port'))
        else resolve(port)
      })
    })
    probe.on('error', reject)
  })
}

/**
 * Starts the identity provider.
 *
 * The port is known before the provider starts, so the issuer url — and with
 * it the redirect uri of the gateway — is stable.
 */
export async function startOidcProvider(
  options: OidcProviderOptions = {}
): Promise<StartedOidcProvider> {
  // This provider holds accounts with known passwords: it is a fixture for
  // the tests and the development stack, never a deployment.
  assertFixtureAllowed('identity provider')
  const users = options.users ?? DEFAULT_USERS
  const clientId = options.clientId ?? 'shuttle'
  const clientSecret = options.clientSecret ?? 'shuttle-secret'
  const redirectUris = options.redirectUris ?? DEFAULT_REDIRECT_URIS
  const port = options.port ?? (await freePort())
  const issuer = (options.issuer ?? `http://localhost:${port}`).replace(/\/+$/, '')
  const log = options.logger ?? (() => {})

  // The keys are replaced in place: the provider holds the reference to the
  // object, so a rotation is seen by the running provider.
  const jwks: { keys: JWK[] } = { keys: [] }
  let currentJwk: JWK | null = null
  const generateKey = async (kid: string): Promise<void> => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk: JWK = await exportJWK(privateKey)
    jwk.kid = kid
    jwk.alg = 'RS256'
    jwk.use = 'sig'
    currentJwk = jwk
    jwks.keys = [jwk]
  }
  await generateKey('shuttle-dev-key-1')

  const findUser = (identifier: string): OidcUser | undefined =>
    users.find(
      (user) => user.sub === identifier || user.email.toLowerCase() === identifier.toLowerCase()
    )

  const provider = new Provider(issuer, {
    jwks,
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    claims: {
      openid: { sub: null },
      profile: { name: null, roles: null },
      email: { email: null, email_verified: null },
    },
    scopes: ['openid', 'profile', 'email'],
    // The gateway reads the e-mail address and the roles from the id token,
    // so they are kept in it instead of being moved to the user info endpoint.
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    findAccount: async (_ctx: unknown, id: string) => {
      const account = findUser(id)
      const subject = account?.sub ?? id
      return {
        accountId: subject,
        async claims() {
          return {
            sub: subject,
            email: account?.email ?? `${subject}@shuttle.test`,
            email_verified: true,
            name: account?.name ?? subject,
            roles: account?.roles ?? [],
          }
        },
      }
    },
    interactions: {
      url: (_ctx: unknown, interaction: { uid: string }) => `/interaction/${interaction.uid}`,
    },
    features: {
      // The provider collects the credentials on its own page.
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: true },
    },
    cookies: { keys: [clientSecret] },
  })

  /** Grants the consent and signs the account in. */
  const finish = async (
    ctx: { req: unknown; res: unknown },
    details: {
      params: Record<string, string>
      prompt: { details: { missingOIDCScope?: string[]; missingOIDCClaims?: string[] } }
    },
    account: OidcUser
  ): Promise<void> => {
    const grant = new provider.Grant({
      accountId: account.sub,
      clientId: details.params.client_id ?? clientId,
    })
    const missingScope = details.prompt.details.missingOIDCScope
    if (missingScope?.length) grant.addOIDCScope(missingScope.join(' '))
    const missingClaims = details.prompt.details.missingOIDCClaims
    if (missingClaims?.length) grant.addOIDCClaims(missingClaims)
    const grantId = await grant.save()
    log(`signed in ${account.email}`)
    await provider.interactionFinished(
      ctx.req,
      ctx.res,
      { login: { accountId: account.sub }, consent: { grantId } },
      { mergeWithLastSubmission: false }
    )
  }

  /**
   * The sign in page of the provider.
   *
   * The provider asks for the account with an interaction, this middleware
   * renders the form and hands the result back to the provider.
   */
  provider.use(async (ctx, next) => {
    if (ctx.path === '/healthz') {
      ctx.type = 'application/json'
      ctx.body = JSON.stringify({ status: 'ok', service: 'shuttle-oidc-provider' })
      return undefined
    }

    const match = /^\/interaction\/([^/]+)$/.exec(ctx.path)
    if (!match) return next()

    let details: Awaited<ReturnType<typeof provider.interactionDetails>>
    try {
      details = await provider.interactionDetails(ctx.req, ctx.res)
    } catch {
      ctx.status = 400
      ctx.body = 'the sign in request is unknown or has expired'
      return undefined
    }

    // The consent screen is skipped, the development provider trusts the
    // client.
    if (details.prompt.name === 'consent') {
      const account = users.find((user) => user.sub === details.session?.accountId)
      if (!account) {
        ctx.status = 400
        ctx.body = 'the sign in request does not belong to a signed in account'
        return undefined
      }
      await finish(ctx, details, account)
      return undefined
    }

    if (ctx.method === 'GET') {
      ctx.type = 'html'
      ctx.body = renderLoginPage(users)
      return undefined
    }

    const form = await readForm(ctx.req as AsyncIterable<Buffer>)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const account = findUser(email)
    if (!account || !sameSecret(account.password, password)) {
      ctx.status = 401
      ctx.type = 'html'
      ctx.body = renderLoginPage(users, 'the account or the password is not correct')
      return undefined
    }
    await finish(ctx, details, account)
    return undefined
  })

  const server: Server = createServer(provider.callback())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })

  return {
    url: issuer,
    issuer,
    clientId,
    clientSecret,
    users,
    privateJwk: currentJwk!,
    rotateKeys: async () => {
      await generateKey(`shuttle-dev-key-${Date.now()}`)
    },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? '5556')
  const issuer = process.env.SHUTTLE_OIDC_ISSUER ?? `http://localhost:${port}`
  const users = process.env.SHUTTLE_OIDC_USERS
    ? (JSON.parse(process.env.SHUTTLE_OIDC_USERS) as OidcUser[])
    : undefined

  let provider: StartedOidcProvider
  try {
    provider = await startOidcProvider({
      port,
      issuer,
      users,
      clientId: process.env.SHUTTLE_OIDC_CLIENT_ID ?? 'shuttle',
      clientSecret: process.env.SHUTTLE_OIDC_CLIENT_SECRET ?? 'shuttle-secret',
      logger: (message) => console.log(JSON.stringify({ level: 'info', msg: message })),
    })
  } catch (error) {
    if (error instanceof FixtureInProductionError) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'the development identity provider must not run in production',
          error: error.message,
        })
      )
      process.exit(1)
    }
    throw error
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'shuttle identity provider started',
      issuer: provider.issuer,
      clientId: provider.clientId,
      port,
    })
  )

  const shutdown = (): void => {
    void provider.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
