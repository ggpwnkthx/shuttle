#!/usr/bin/env bun
/**
 * The development identity provider.
 *
 * The OpenID Connect protocol is implemented by the `oidc-provider` package,
 * this module only configures it, keeps the fixture accounts and renders the
 * sign in page of the provider. It is a development fixture and is never used
 * in a deployment: the compose stack runs dex instead.
 *
 * The module is used in two ways:
 *
 * - started directly (`bun run services/oidc-provider.ts`), for the compose
 *   stack and for a standalone run
 * - imported (`startOidcProvider`), for the development runner and the tests
 */
import { createServer, type Server } from 'node:http'
import Provider from 'oidc-provider'
import { exportJWK, generateKeyPair, type JWK } from 'jose'
import { html } from 'hono/html'
import { timingSafeEqualString } from '../src/auth/crypto'
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
  /** Public issuer URL; defaults to `http://localhost:<port>`. */
  issuer?: string
  users?: OidcUser[]
  clientId?: string
  clientSecret?: string
  /** Redirect URIs the client is allowed to use. */
  redirectUris?: string[]
  logger?: (message: string) => void
}

export interface StartedOidcProvider {
  url: string
  issuer: string
  clientId: string
  clientSecret: string
  users: OidcUser[]
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

/**
 * Renders the sign in page of the development identity provider.
 *
 * The template escapes every value it interpolates, so an account name can
 * never become markup.
 */
function renderLoginPage(accounts: OidcUser[], error?: string): string {
  const options = accounts.map(
    (account) =>
      html`<option value="${account.email}">${account.email} — ${account.roles.join(', ')}</option>`
  )
  const accounts_ = accounts.map((account) => account.email)
  // The template holds no promise, so the result is a string.
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shuttle identity provider</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;margin:4rem auto;max-width:24rem;color:#111}
label{display:block;margin:.75rem 0 .25rem}input,select{width:100%;padding:.45rem;box-sizing:border-box}
button{margin-top:1rem;padding:.5rem 1rem}</style></head>
<body><h1>Sign in</h1>
${error ? html`<p style="color:#b91c1c">${error}</p>` : ''}
<form method="post">
<label for="email">Account</label>
<select id="email" name="email">${options}</select>
<label for="password">Password</label>
<input id="password" name="password" type="password" />
<button type="submit">Sign in</button>
</form>
<p><small>Development identity provider (oidc-provider). Accounts: ${accounts_.join(', ')}</small></p>
</body></html>` as string
}

/** Reads an `application/x-www-form-urlencoded` body. */
async function readForm(req: unknown): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** Finds a free port, so the issuer can be known before the provider starts. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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
  // This provider holds accounts with known passwords: it is a fixture for the
  // tests and the development stack, never a deployment.
  assertFixtureAllowed('identity provider')
  const users = options.users ?? DEFAULT_USERS
  const clientId = options.clientId ?? 'shuttle'
  const clientSecret = options.clientSecret ?? 'shuttle-secret'
  const redirectUris = options.redirectUris ?? DEFAULT_REDIRECT_URIS
  const port = options.port ?? (await freePort())
  const issuer = (options.issuer ?? `http://localhost:${port}`).replace(/\/+$/, '')
  const log = options.logger ?? (() => {})

  const { privateKey } = await generateKeyPair('RS256', { extractable: true })
  const privateJwk: JWK = await exportJWK(privateKey)
  privateJwk.kid = 'shuttle-dev-key'
  privateJwk.alg = 'RS256'
  privateJwk.use = 'sig'

  const findUser = (identifier: string): OidcUser | undefined =>
    users.find(
      (user) =>
        user.sub === identifier || user.email.toLowerCase() === identifier.toLowerCase()
    )

  const provider = new Provider(issuer, {
    jwks: { keys: [privateJwk] },
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

    const form = await readForm(ctx.req)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const account = findUser(email)
    if (!account || !timingSafeEqualString(account.password, password)) {
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
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 5556)
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
