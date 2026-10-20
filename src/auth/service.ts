import type { Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { SESSION_COOKIE_NAME, STATE_COOKIE_NAME } from './cookies'
import { OidcError, type OidcClient } from './oidc'
import { SessionStoreError, type SessionRecord, type SessionStore } from './session'
import type { AuthMode } from '../config/schema'
import type { Logger } from '../log/logger'

export interface Principal {
  subject: string
  email?: string
  roles: string[]
  /**
   * The credential that authenticated the caller.
   *
   * The gateway needs it to know whether the request comes from a browser:
   * only a session cookie is vulnerable to a cross site request.
   */
  source: 'session' | 'jwt'
}

export interface AuthServiceOptions {
  oidc: OidcClient
  sessions: SessionStore
  /** Secret used to sign the OIDC state cookie. */
  secret: string
  cookieSecure?: boolean
  logger?: Logger
}

interface LoginState {
  state: string
  nonce: string
  verifier: string
  redirect: string
  exp: number
}

const DEFAULT_SESSION_COOKIE = SESSION_COOKIE_NAME
const DEFAULT_STATE_COOKIE = STATE_COOKIE_NAME

/** The path every cookie of the gateway is scoped to. */
const COOKIE_PATH = '/'

/**
 * Authentication facade used by the gateway.
 *
 * Browser callers are authenticated with an opaque session cookie, API
 * callers with a bearer JWT. Both are validated against the same OIDC
 * provider.
 */

/** The credential sources the gateway knows. */
export type CredentialSource = 'session' | 'jwt'

/**
 * The credential sources a mode accepts, in the order they are evaluated.
 *
 * The order is fixed, so the credential that authenticates a request is
 * predictable and does not depend on the shape of the request:
 *
 * - `none`   no credential is accepted
 * - `session` only the session cookie
 * - `jwt`    only the bearer token
 * - `any`    the bearer token first, the session cookie second
 *
 * A route that accepts bearer tokens prefers the explicit `Authorization`
 * header over the cookie, and a credential that is present but invalid is
 * rejected instead of falling back to another one.
 */
function acceptedSources(mode: AuthMode): CredentialSource[] {
  switch (mode) {
    case 'none':
      return []
    case 'session':
      return ['session']
    case 'jwt':
      return ['jwt']
    case 'any':
      return ['jwt', 'session']
  }
}

export class AuthService {
  readonly oidc: OidcClient
  readonly sessions: SessionStore
  #secret: string
  #sessionCookieName: string
  #stateCookieName: string
  #cookieSecure: boolean
  #logger?: Logger

  constructor(options: AuthServiceOptions) {
    this.oidc = options.oidc
    this.sessions = options.sessions
    this.#secret = options.secret
    this.#sessionCookieName = DEFAULT_SESSION_COOKIE
    this.#stateCookieName = DEFAULT_STATE_COOKIE
    this.#cookieSecure = options.cookieSecure ?? true
    this.#logger = options.logger
  }

  /**
   * Reports whether the request carries the session cookie of the gateway.
   *
   * The cookie is scoped to the root of the gateway, so a browser sends it
   * to every path of it, also to the routes that do not authenticate. A
   * request that carries it is a request of a browser, and a browser can be
   * made to send a request from another site. The cross site guard uses
   * this, so a route without a policy is guarded as well.
   */
  hasSessionCookie(c: Context): boolean {
    const value = getCookie(c, this.#sessionCookieName)
    return typeof value === 'string' && value.length > 0
  }

  /**
   * Resolves the caller.
   *
   * The mode of the route decides which credentials are accepted, the order
   * of `acceptedSources` decides which one is used.
   */
  async authenticate(c: Context, mode: AuthMode = 'any'): Promise<Principal | null> {
    const sources = acceptedSources(mode)
    if (sources.length === 0) return null

    const authorization = c.req.header('authorization')
    if (authorization !== undefined && sources.includes('jwt')) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
      if (!match) {
        // A credential that the route does not accept is not a credential.
        return null
      }
      const token = match[1]!.trim()
      if (!token) return null
      try {
        const identity = await this.oidc.verifyToken(token)
        return {
          subject: identity.subject,
          email: identity.email,
          roles: identity.roles,
          source: 'jwt',
        }
      } catch {
        // An invalid token is rejected, the session is not used as a
        // fallback: the caller asked for a token and the token is wrong.
        return null
      }
    }

    if (sources.includes('session')) {
      const session = await this.#readSession(getCookie(c, this.#sessionCookieName))
      if (session) return this.#principalFromSession(session)
    }
    return null
  }

  /**
   * Reads a session from the store.
   *
   * A store that cannot be reached denies the caller: the gateway never lets
   * somebody in because the session store had a hiccup.
   */
  async #readSession(id: string | undefined): Promise<SessionRecord | null> {
    try {
      return await this.sessions.get(id)
    } catch (error) {
      this.#logger?.warn('the session store is not reachable', { error })
      return null
    }
  }

  #principalFromSession(session: SessionRecord): Principal {
    return {
      subject: session.subject,
      email: session.email,
      roles: session.roles,
      source: 'session',
    }
  }

  #setCookie(c: Context, name: string, value: string, maxAgeSeconds: number): void {
    setCookie(c, name, value, {
      httpOnly: true,
      secure: this.#cookieSecure,
      sameSite: 'Lax',
      path: COOKIE_PATH,
      maxAge: maxAgeSeconds,
    })
  }

  /**
   * Starts the browser login flow and returns the redirect to the provider.
   *
   * The target of the post login redirect is always a relative path, so a
   * crafted parameter can never turn the login into an open redirect.
   */
  async beginLogin(c: Context, redirectTo: string): Promise<Response> {
    const request = await this.oidc.createAuthorizationRequest()
    const state: LoginState = {
      state: request.state,
      nonce: request.nonce,
      verifier: request.codeVerifier,
      redirect: resolveRedirect(redirectTo),
      exp: Date.now() + 10 * 60_000,
    }
    await setSignedCookie(c, this.#stateCookieName, JSON.stringify(state), this.#secret, {
      httpOnly: true,
      secure: this.#cookieSecure,
      sameSite: 'Lax',
      path: COOKIE_PATH,
      maxAge: 600,
    })
    const url = await this.oidc.authorizationUrl({
      state: request.state,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
    })
    return c.redirect(url, 302)
  }

  /**
   * Completes the browser login flow: validates state, exchanges the code and
   * creates a server side session.
   */
  async completeLogin(
    c: Context,
    params: { code?: string; state?: string; error?: string }
  ): Promise<{ principal: Principal; redirect: string }> {
    if (params.error) {
      throw new OidcError('login_failed', `identity provider returned an error: ${params.error}`)
    }
    if (!params.code) {
      throw new OidcError('login_failed', 'authorization code is missing')
    }
    const raw = await getSignedCookie(c, this.#secret, this.#stateCookieName)
    if (!raw) {
      throw new OidcError('login_failed', 'the login request could not be verified')
    }
    deleteCookie(c, this.#stateCookieName, { path: COOKIE_PATH })
    let state: LoginState
    try {
      state = JSON.parse(raw) as LoginState
    } catch {
      throw new OidcError('login_failed', 'the login request could not be decoded')
    }
    if (state.exp < Date.now()) {
      throw new OidcError('login_failed', 'the login request expired')
    }
    if (!params.state || params.state !== state.state) {
      throw new OidcError('login_failed', 'the login state does not match')
    }

    const identity = await this.oidc.exchangeCode(new URL(c.req.url).searchParams, state.verifier, {
      nonce: state.nonce,
      state: state.state,
    })
    const session = await this.#createSession({
      subject: identity.subject,
      email: identity.email,
      roles: identity.roles,
    })
    this.#setCookie(c, this.#sessionCookieName, session.id, Math.floor(this.sessions.ttlMs / 1000))
    return {
      principal: this.#principalFromSession(session),
      redirect: state.redirect,
    }
  }

  /** Creates a session and reports a broken store as a store error. */
  async #createSession(input: {
    subject: string
    email?: string
    roles?: string[]
  }): Promise<SessionRecord> {
    try {
      return await this.sessions.create({
        subject: input.subject,
        email: input.email,
        roles: input.roles,
        ttlMs: this.sessions.ttlMs,
      })
    } catch (error) {
      this.#logger?.warn('the session store is not reachable', { error })
      throw new SessionStoreError('the session store is not reachable', error)
    }
  }

  async logout(c: Context): Promise<void> {
    const sessionId = getCookie(c, this.#sessionCookieName)
    try {
      await this.sessions.destroy(sessionId)
    } catch (error) {
      // The cookie is removed in any case, the session dies with its lifetime.
      this.#logger?.warn('the session could not be revoked', { error })
    }
    deleteCookie(c, this.#sessionCookieName, { path: COOKIE_PATH })
  }

}

/**
 * Only relative, single-slash paths are accepted as post-login targets.
 *
 * The value is the target of a `Location` header, so a control character
 * in it would be a header injection, and a target that a browser resolves
 * to another origin would be an open redirect. Both are refused.
 */
function resolveRedirect(value: string | undefined | null): string {
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  if (value.includes('\\')) return '/'
  // A control character is never part of a path. Browsers strip tabs and
  // newlines from a url before they resolve it, so `/\t/evil.com` would
  // become `//evil.com` and leave the site.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return '/'
  }
  return value
}
