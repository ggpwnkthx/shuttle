/**
 * The OpenID Connect relying party of the gateway.
 *
 * The protocol itself is implemented by the `openid-client` library and the
 * validation of the tokens is implemented by `jose`: the gateway decides
 * which credentials it accepts and how a rejection is reported, it does not
 * implement a protocol that a library already implements.
 *
 * Two credentials are validated against the same provider:
 *
 * - the **browser flow**: the authorization code is exchanged, the id token
 *   is required, the nonce and the state are checked and the PKCE verifier
 *   is presented;
 * - the **bearer token** of an API client: the signature (through the
 *   remote JWKS set of the provider), the issuer, the audience and the
 *   expiry are checked.
 */

import {
  ClientSecretBasic,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type CustomFetch,
} from 'openid-client'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { z } from 'zod'

/** The identity of a caller, as the provider describes it. */
export interface VerifiedIdentity {
  subject: string
  email?: string
  roles: string[]
}

/** A failure of the identity provider. */
export class OidcError extends Error {
  /** The code of the failure, as the gateway reports it. */
  readonly code: string
  override readonly cause: unknown

  constructor(code: string, message: string, cause?: unknown) {
    super(message)
    this.name = 'OidcError'
    this.code = code
    this.cause = cause
  }
}

/** The settings of the relying party. */
export interface OidcClientOptions {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /** The expected audience of a bearer token (defaults to the client id). */
  audience?: string
  /** The claim that carries the roles. */
  rolesClaim?: string
  /**
   * The claims a bearer token has to carry.
   *
   * The gateway validates the signature, the issuer, the audience, the
   * expiry and the subject of a bearer token, and nothing else: many
   * providers do not publish a claim that says the token is an access
   * token. A provider that does publish one is named here, and a token that
   * does not carry it is refused.
   */
  requiredTokenClaims?: string[]
  /**
   * The longest validity a bearer token may have, in milliseconds.
   *
   * The gateway refuses a bearer token whose **lifetime** is longer than
   * this: the moment it was issued and the moment it expires. The bound is
   * what turns the removal of a caller from the identity provider into a
   * bounded delay: the token of a caller that was removed is refused after
   * at most this long, and not after the lifetime the provider gave it.
   *
   * The bound is applied to the lifetime and not to the validity that is
   * left, so a long-lived token does not become acceptable again when it
   * is close to its expiry.
   *
   * A bearer token has to carry the moment it was issued while the bound
   * is on: without it the length of the lifetime cannot be known.
   *
   * Zero disables the bound. The bound is not the only rule: a bearer token
   * has to carry an expiry whatever the bound is, so a token that never
   * expires is always refused.
   */
  maxTokenAgeMs?: number
  /**
   * Refuses a bearer token that carries a nonce.
   *
   * The browser flow of the gateway always asks for a nonce, so an id token
   * of this client always carries one, and an access token never does. A
   * provider whose access tokens carry a nonce anyway turns this off.
   */
  rejectNonceTokens?: boolean
  /** How long the metadata of the provider is cached, in milliseconds. */
  discoveryTtlMs?: number
  /** The timeout of a call to the provider, in milliseconds. */
  requestTimeoutMs?: number
  /** The fetch of the provider; injected for the tests. */
  fetchImpl?: CustomFetch
  /**
   * Allows an issuer that is not served over https.
   *
   * Only for a development environment: a deployment terminates TLS in
   * front of the identity provider.
   */
  allowInsecureIssuer?: boolean
  /**
   * Allows a client without a secret.
   *
   * A public client is a client that anyone can impersonate: the provider
   * accepts the code of the browser without a proof that the caller is the
   * gateway. It is refused unless the deployment allows it explicitly.
   */
  allowPublicClient?: boolean
}

/**
 * The claim that carries the roles.
 *
 * A provider may send a list of roles or a single delimited string; both
 * are accepted, anything else means the caller has no roles at all.
 */
const RolesClaimSchema = z
  .union([
    z
      .array(z.unknown())
      .transform((values) => values.filter((value): value is string => typeof value === 'string')),
    z.string().transform((value) =>
      value
        .split(/[\s,]+/)
        .map((role) => role.trim())
        .filter(Boolean)
    ),
  ])
  .catch([])

/** The algorithms a bearer token may be signed with. */
export const ACCEPTED_ALGORITHMS = ['RS256', 'ES256', 'RS384', 'RS512', 'ES384', 'PS256'] as const

/** The tolerance of the clock, in seconds. */
export const CLOCK_TOLERANCE_SECONDS = 5

/** The issuer without its trailing slashes. */
function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Reads the roles of a caller from the claims of a token. */
export function extractRoles(claims: JWTPayload, claim: string): string[] {
  return RolesClaimSchema.parse(claims[claim] ?? [])
}

/**
 * The port of the identity provider.
 *
 * The use cases of the authentication depend on the port and not on the
 * implementation: the tests use a fake and the deployment uses the
 * relying party.
 */
export interface OidcPort {
  /** A fresh challenge of a browser login. */
  createAuthorizationRequest(): Promise<{
    state: string
    nonce: string
    codeVerifier: string
    codeChallenge: string
  }>
  /** Builds the authorization url of a browser login. */
  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string>
  /** Exchanges an authorization code for the identity of the caller. */
  exchangeCode(
    responseParams: URLSearchParams,
    codeVerifier: string,
    options?: { nonce: string; state?: string }
  ): Promise<VerifiedIdentity>
  /** Validates a bearer token. */
  verifyToken(token: string, options?: { nonce?: string }): Promise<VerifiedIdentity>
}

/**
 * The relying party of the gateway.
 *
 * The metadata of the provider is discovered from the issuer and cached, the
 * signing keys are fetched lazily through a remote JWKS set.
 */
export class OidcClient implements OidcPort {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly redirectUri: string
  readonly scopes: string[]
  readonly audience: string
  readonly rolesClaim: string
  #fetch: CustomFetch
  #discoveryTtlMs: number
  #requestTimeoutMs: number
  #allowInsecureIssuer: boolean
  #requiredTokenClaims: string[]
  #rejectNonceTokens: boolean
  #maxTokenAgeMs: number
  #metadata: Configuration | null = null
  #metadataFetchedAt = 0
  #metadataPromise: Promise<Configuration> | null = null
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null

  constructor(options: OidcClientOptions) {
    this.issuer = normalizeIssuer(options.issuer)
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    if (!this.clientSecret && options.allowPublicClient === false) {
      throw new OidcError(
        'client_configuration_invalid',
        'the client has no secret and the deployment does not allow a public client'
      )
    }
    this.redirectUri = options.redirectUri
    this.scopes = options.scopes ?? ['openid', 'profile', 'email']
    this.audience = options.audience ?? options.clientId
    this.rolesClaim = options.rolesClaim ?? 'roles'
    this.#requiredTokenClaims = options.requiredTokenClaims ?? []
    this.#rejectNonceTokens = options.rejectNonceTokens ?? true
    this.#maxTokenAgeMs = options.maxTokenAgeMs ?? 0
    this.#fetch = options.fetchImpl ?? (fetch as unknown as CustomFetch)
    this.#discoveryTtlMs = options.discoveryTtlMs ?? 10 * 60_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.#allowInsecureIssuer = options.allowInsecureIssuer ?? false
  }

  /** The metadata of the provider, using the cached copy when it is fresh. */
  async metadata(): Promise<Configuration> {
    if (this.#metadata && Date.now() - this.#metadataFetchedAt < this.#discoveryTtlMs) {
      return this.#metadata
    }
    if (!this.#metadataPromise) {
      this.#metadataPromise = this.#discover().finally(() => {
        this.#metadataPromise = null
      })
    }
    return this.#metadataPromise
  }

  /** Discovers the metadata of the provider. */
  async #discover(): Promise<Configuration> {
    let configuration: Configuration
    try {
      configuration = await discovery(
        new URL(this.issuer),
        this.clientId,
        {
          client_secret: this.clientSecret,
          redirect_uris: [this.redirectUri],
          token_endpoint_auth_method: this.clientSecret ? 'client_secret_basic' : 'none',
        },
        this.clientSecret ? ClientSecretBasic(this.clientSecret) : undefined,
        {
          execute: this.#allowInsecureIssuer ? [allowInsecureRequests] : [],
          [customFetch]: this.#fetch,
        }
      )
    } catch (error) {
      if (this.#metadata) return this.#metadata
      throw new OidcError(
        'discovery_failed',
        `unable to reach the identity provider: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
    // The provider has to be the one the deployment configured: a discovery
    // that names another issuer is refused.
    const discovered = normalizeIssuer(configuration.serverMetadata().issuer)
    if (discovered !== this.issuer) {
      throw new OidcError(
        'discovery_issuer_mismatch',
        `identity provider issuer "${discovered}" does not match the configured issuer`
      )
    }
    this.#metadata = configuration
    this.#metadataFetchedAt = Date.now()
    this.#jwks = null
    return configuration
  }

  /** The remote JWKS set of the provider. */
  #keys(configuration: Configuration): ReturnType<typeof createRemoteJWKSet> {
    if (!this.#jwks) {
      const jwksUri = configuration.serverMetadata().jwks_uri
      if (!jwksUri) {
        throw new OidcError('discovery_invalid', 'the identity provider has no jwks uri')
      }
      this.#jwks = createRemoteJWKSet(new URL(jwksUri), {
        timeoutDuration: this.#requestTimeoutMs,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      })
    }
    return this.#jwks
  }

  /** Builds the authorization url of a browser login. */
  async authorizationUrl(params: {
    state: string
    nonce: string
    codeChallenge: string
  }): Promise<string> {
    const configuration = await this.metadata()
    const url = buildAuthorizationUrl(configuration, {
      scope: this.scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: this.redirectUri,
    })
    return url.toString()
  }

  /** A fresh challenge of a browser login. */
  async createAuthorizationRequest(): Promise<{
    state: string
    nonce: string
    codeVerifier: string
    codeChallenge: string
  }> {
    const codeVerifier = randomPKCECodeVerifier()
    return {
      state: randomState(),
      nonce: randomNonce(),
      codeVerifier,
      codeChallenge: await calculatePKCECodeChallenge(codeVerifier),
    }
  }

  /**
   * Exchanges an authorization code for the identity of the caller.
   *
   * The response parameters are the ones of the callback of the provider:
   * the code, the state and the issuer. The library validates the
   * authorization response, the signature of the id token, the nonce and
   * the audience: a response that does not belong to the request is
   * rejected.
   *
   * The redirect uri of the exchange is the configured one, never the url
   * the browser happened to call: the gateway may be reached under another
   * name than the one the identity provider knows.
   */
  async exchangeCode(
    responseParams: URLSearchParams,
    codeVerifier: string,
    options: { nonce: string; state?: string } = { nonce: '' }
  ): Promise<VerifiedIdentity> {
    const configuration = await this.metadata()
    const currentUrl = new URL(this.redirectUri)
    for (const [key, value] of responseParams) {
      currentUrl.searchParams.set(key, value)
    }
    try {
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedNonce: options.nonce,
        expectedState: options.state,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (!claims) {
        throw new OidcError('login_failed', 'the identity provider did not return an id token')
      }
      if (!claims.sub) {
        throw new OidcError('token_invalid', 'the id token does not contain a subject')
      }
      return {
        subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        roles: extractRoles(claims, this.rolesClaim),
      }
    } catch (error) {
      if (error instanceof OidcError) throw error
      throw new OidcError(
        'token_exchange_failed',
        `token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
  }

  /**
   * Validates a bearer token: its signature, its issuer, its audience and
   * its expiry.
   *
   * It also refuses a token that is not an access token. Many providers
   * publish an id token and an access token for the same client and the
   * same audience, and an id token travels through the browser: it lands in
   * the history, in the logs and in the referrers. Accepting one as a
   * bearer credential hands a token that was meant for the browser to every
   * route that accepts a bearer token.
   *
   * The id token of this client always carries a nonce — the browser flow
   * always asks for one — and an access token never does, so a bearer
   * token that carries a nonce is refused. A provider that publishes a
   * claim that names the type of the token is named in
   * `requiredTokenClaims`, and a token that does not carry it is refused
   * as well.
   */
  async verifyToken(token: string, options: { nonce?: string } = {}): Promise<VerifiedIdentity> {
    const configuration = await this.metadata()
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, this.#keys(configuration), {
        issuer: configuration.serverMetadata().issuer,
        audience: this.audience,
        algorithms: [...ACCEPTED_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })
      payload = verified.payload
    } catch (error) {
      throw new OidcError(
        'token_invalid',
        `token validation failed: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
    if (!payload.sub) {
      throw new OidcError('token_invalid', 'token does not contain a subject')
    }
    // A nonce is not required for an API token (it is not bound to a login
    // attempt); when one is passed, it has to match. A token that is
    // verified against a nonce is an id token and not a bearer token, so
    // the check of the type of the token does not apply to it.
    if (options.nonce && payload.nonce !== options.nonce) {
      throw new OidcError('token_invalid', 'token nonce does not match the authentication request')
    }
    if (!options.nonce) {
      if (this.#rejectNonceTokens && payload.nonce !== undefined) {
        throw new OidcError(
          'token_invalid',
          'the token carries a nonce: it is an id token and not an access token'
        )
      }
      for (const claim of this.#requiredTokenClaims) {
        if (payload[claim] === undefined) {
          throw new OidcError(
            'token_invalid',
            `the token does not carry the claim "${claim}" the deployment requires`
          )
        }
      }
      // A bearer token has to expire.
      //
      // The expiry is checked by the library **when the token carries
      // one**: a token without an `exp` claim passes the validation of the
      // signature and of the issuer, and it is valid forever. The gateway
      // refuses it: a credential that a caller cannot spend is a
      // credential that nobody can revoke.
      if (payload.exp === undefined) {
        throw new OidcError('token_invalid', 'the token does not carry an expiry')
      }
      // The lifetime of the token is bounded.
      //
      // The rule is applied to the **lifetime** of the token: the moment
      // it was issued and the moment it expires. A token that was issued
      // with a long lifetime is refused from the moment it is presented,
      // and it does not become acceptable again when it is close to its
      // expiry: the bound is on the lifetime, and not on the validity that
      // is left.
      //
      // The moment the token was issued is required for that: without it
      // the length of the lifetime cannot be known, and a credential whose
      // length cannot be bounded is a credential that cannot be revoked.
      // Every provider publishes it: RFC 9068 makes it mandatory for an
      // access token.
      //
      // The bound is what turns the removal of a caller from the identity
      // provider into a delay that is bounded by the deployment: the token
      // of a caller that was removed keeps working for at most this long.
      if (this.#maxTokenAgeMs > 0) {
        if (payload.iat === undefined) {
          throw new OidcError(
            'token_invalid',
            'the token does not carry the moment it was issued, so the length of its lifetime cannot be bounded'
          )
        }
        const lifetimeMs = payload.exp * 1000 - payload.iat * 1000
        if (lifetimeMs > this.#maxTokenAgeMs) {
          throw new OidcError(
            'token_invalid',
            `the token is valid for longer than the maximum the deployment allows (${this.#maxTokenAgeMs} ms)`
          )
        }
      }
    }
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      roles: extractRoles(payload, this.rolesClaim),
    }
  }
}
