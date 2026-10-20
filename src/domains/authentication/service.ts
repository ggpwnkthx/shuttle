/**
 * The use cases of the authentication.
 *
 * The service authenticates a request, starts a browser login, completes it
 * and ends a session. It knows nothing about the framework of the
 * application: the cookies of a request are given to it as values and the
 * cookies of an answer are given back to the application, which writes them.
 */

import {
  GATEWAY_COOKIE_NAMES,
  SessionStoreError,
  cookieMaxAgeSeconds,
  loginStateCookie,
  loginStateDeletionCookie,
  sessionCookie,
  sessionDeletionCookie,
  type CookieOptions,
  type CreateSessionInput,
  type GatewayCookie,
  type SessionRecord,
  type SessionStore,
} from './index'
import {
  LOGIN_STATE_TTL_MS,
  sanitizeRedirectTarget,
  signLoginState,
  verifyLoginState,
  type LoginState,
} from './login-state'
import { OidcError, type OidcPort, type VerifiedIdentity } from './oidc'
import { selectCredential, type CredentialPlan, type Principal } from './principal'

/** The logger the service uses. */
export interface AuthLogger {
  warn(message: string, fields?: Record<string, unknown>): void
}

/** The settings of the service. */
export interface AuthenticationServiceOptions {
  /** The identity provider of the gateway. */
  oidc: OidcPort
  /** The store of the sessions. */
  sessions: SessionStore
  /** The secret that signs the state of a login. */
  secret: string
  /** The attributes of the cookies of the gateway. */
  cookies: CookieOptions
  logger?: AuthLogger
}

/** The outcome of the authentication of a request. */
export interface AuthenticationOutcome {
  principal: Principal
  /**
   * The session of the caller, when the session cookie authenticated it.
   *
   * The application refreshes the cookie of the browser with it, also when
   * the request is refused: the browser has to learn about the new lifetime
   * of the session even then.
   */
  session?: { record: SessionRecord; cookie: GatewayCookie }
}

/** The outcome of the start of a browser login. */
export interface BeginLoginOutcome {
  /** The url of the provider the browser is sent to. */
  authorizationUrl: string
  /** The cookie that carries the state of the login. */
  stateCookie: GatewayCookie
}

/** The outcome of the end of a browser login. */
export interface CompleteLoginOutcome {
  principal: Principal
  /** The target of the redirect after the login. */
  redirect: string
  /** The cookie that carries the session of the caller. */
  sessionCookie: GatewayCookie
}

export class AuthenticationService {
  readonly oidc: OidcPort
  readonly sessions: SessionStore
  #secret: string
  #cookies: CookieOptions
  #logger?: AuthLogger

  constructor(options: AuthenticationServiceOptions) {
    this.oidc = options.oidc
    this.sessions = options.sessions
    this.#secret = options.secret
    this.#cookies = options.cookies
    this.#logger = options.logger
  }

  /** The names of the cookies the gateway owns. */
  get gatewayCookieNames(): readonly string[] {
    return GATEWAY_COOKIE_NAMES
  }

  /**
   * Validates the credential of a request.
   *
   * A store that cannot be reached denies the caller: the gateway never
   * lets somebody in because the session store had a hiccup.
   */
  async authenticate(plan: CredentialPlan): Promise<AuthenticationOutcome | null> {
    if (plan.kind === 'none' || plan.kind === 'reject') return null

    if (plan.kind === 'bearer') {
      let identity: VerifiedIdentity
      try {
        identity = await this.oidc.verifyToken(plan.token)
      } catch (error) {
        this.#logger?.warn('the bearer token was refused', { error })
        return null
      }
      return {
        principal: {
          subject: identity.subject,
          email: identity.email,
          roles: identity.roles,
          source: 'jwt',
        },
      }
    }

    let record: SessionRecord | null
    try {
      record = await this.sessions.get(plan.sessionId)
    } catch (error) {
      this.#logger?.warn('the session store is not reachable', { error })
      return null
    }
    if (!record) return null
    return {
      principal: {
        subject: record.subject,
        email: record.email,
        roles: record.roles,
        source: 'session',
      },
      session: { record, cookie: this.renewalCookie(record) },
    }
  }

  /**
   * The refreshed cookie of a session.
   *
   * The cookie follows the session: its lifetime is the lifetime that is
   * left of the session, so it never outlives the session it names.
   */
  renewalCookie(record: SessionRecord): GatewayCookie {
    return sessionCookie(record.id, cookieMaxAgeSeconds(record), this.#cookies)
  }

  /**
   * Starts a browser login.
   *
   * The target of the redirect after the login is always a relative path,
   * so a crafted parameter can never turn the login into an open redirect.
   */
  async beginLogin(redirectTo: string): Promise<BeginLoginOutcome> {
    const request = await this.oidc.createAuthorizationRequest()
    const state: LoginState = {
      state: request.state,
      nonce: request.nonce,
      verifier: request.codeVerifier,
      redirect: sanitizeRedirectTarget(redirectTo),
      exp: Date.now() + LOGIN_STATE_TTL_MS,
    }
    const authorizationUrl = await this.oidc.authorizationUrl({
      state: request.state,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
    })
    return {
      authorizationUrl,
      stateCookie: loginStateCookie(
        signLoginState(state, this.#secret),
        Math.floor(LOGIN_STATE_TTL_MS / 1000),
        this.#cookies
      ),
    }
  }

  /**
   * Completes a browser login.
   *
   * The state of the login is single use: the cookie is deleted as soon as
   * the callback is processed, the state of the callback has to be the state
   * of the cookie, and the verifier and the nonce bind the exchange to this
   * login attempt.
   */
  async completeLogin(input: {
    code?: string
    state?: string
    error?: string
    stateCookie?: string
  }): Promise<CompleteLoginOutcome> {
    if (input.error) {
      throw new OidcError('login_failed', `identity provider returned an error: ${input.error}`)
    }
    if (!input.code) {
      throw new OidcError('login_failed', 'authorization code is missing')
    }
    const state = verifyLoginState(input.stateCookie, this.#secret)
    if (!state) {
      throw new OidcError('login_failed', 'the login request could not be verified')
    }
    if (!input.state || input.state !== state.state) {
      throw new OidcError('login_failed', 'the login state does not match')
    }

    const identity = await this.oidc.exchangeCode(
      new URLSearchParams({ code: input.code, state: input.state }),
      state.verifier,
      { nonce: state.nonce, state: state.state }
    )

    const session = await this.#createSession({
      subject: identity.subject,
      email: identity.email,
      roles: identity.roles,
    })
    return {
      principal: {
        subject: session.subject,
        email: session.email,
        roles: session.roles,
        source: 'session',
      },
      redirect: state.redirect,
      sessionCookie: this.renewalCookie(session),
    }
  }

  /**
   * Ends a session.
   *
   * The cookie of the browser is deleted in any case: a session that could
   * not be revoked dies with its lifetime anyway.
   */
  async logout(sessionId: string | undefined): Promise<GatewayCookie> {
    try {
      await this.sessions.destroy(sessionId)
    } catch (error) {
      this.#logger?.warn('the session could not be revoked', { error })
    }
    return sessionDeletionCookie(this.#cookies)
  }

  /** The cookie that deletes the state of a login that is in flight. */
  loginStateDeletion(): GatewayCookie {
    return loginStateDeletionCookie(this.#cookies)
  }

  /** Creates a session and reports a broken store as a store error. */
  async #createSession(input: CreateSessionInput): Promise<SessionRecord> {
    try {
      return await this.sessions.create(input)
    } catch (error) {
      this.#logger?.warn('the session store is not reachable', { error })
      throw new SessionStoreError('the session store is not reachable', error)
    }
  }
}

export { selectCredential }
export type { CredentialInput, CredentialPlan, Principal } from './principal'
