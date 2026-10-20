/**
 * Minimal OpenID Connect relying party.
 *
 * Supports the browser authorization code flow with PKCE and JWT validation
 * for API clients. The protocol itself is implemented by the `openid-client`
 * library, the gateway only decides which credentials it accepts and how a
 * rejection is reported.
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

export interface VerifiedIdentity {
  subject: string
  email?: string
  roles: string[]
}

export interface OidcClientOptions {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /** Expected audience for API tokens (defaults to the client id). */
  audience?: string
  /** Claim used to read roles from. */
  rolesClaim?: string
  discoveryTtlMs?: number
  requestTimeoutMs?: number
  fetchImpl?: CustomFetch
  /**
   * Allows an issuer that is not served over https.
   *
   * Only for a development environment: a production deployment terminates
   * TLS in front of the identity provider.
   */
  allowInsecureIssuer?: boolean
}

export class OidcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OidcError'
    this.code = code
  }
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * The claim that carries the roles.
 *
 * A provider may send a list of roles or a single delimited string; both are
 * accepted, anything else means the caller has no roles at all. The claim is
 * validated like the rest of the configuration.
 */
const RolesClaimSchema = z
  .union([
    z
      .array(z.unknown())
      .transform((values) => values.filter((value): value is string => typeof value === 'string')),
    z
      .string()
      .transform((value) =>
        value
          .split(/[\s,]+/)
          .map((role) => role.trim())
          .filter(Boolean)
      ),
  ])
  .catch([])

/** Reads the roles of a caller from the claims of a token. */
function extractRoles(claims: JWTPayload, claim: string): string[] {
  return RolesClaimSchema.parse(claims[claim] ?? [])
}

/**
 * The OpenID Connect relying party of the gateway.
 *
 * The provider metadata is discovered from the issuer and cached, the signing
 * keys are fetched lazily through a remote JWKS set.
 */
export class OidcClient {
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
  #metadata: Configuration | null = null
  #metadataFetchedAt = 0
  #metadataPromise: Promise<Configuration> | null = null
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null

  constructor(options: OidcClientOptions) {
    this.issuer = normalizeIssuer(options.issuer)
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.redirectUri = options.redirectUri
    this.scopes = options.scopes ?? ['openid', 'profile', 'email']
    this.audience = options.audience ?? options.clientId
    this.rolesClaim = options.rolesClaim ?? 'roles'
    this.#fetch = options.fetchImpl ?? (fetch as unknown as CustomFetch)
    this.#discoveryTtlMs = options.discoveryTtlMs ?? 10 * 60_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.#allowInsecureIssuer = options.allowInsecureIssuer ?? false
  }

  /** Returns the provider configuration, using the cached copy when fresh. */
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
        `unable to reach the identity provider: ${error instanceof Error ? error.message : String(error)}`
      )
    }
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

  /** Builds the authorization URL for a browser login. */
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

  /**
   * Exchanges an authorization code for the identity of the caller.
   *
   * The response parameters are the ones of the callback of the provider: the
   * code, the state and the issuer. The library validates the authorization
   * response, the signature of the id token, the nonce and the audience: a
   * response that does not belong to the request is rejected.
   *
   * The redirect uri of the exchange is the configured one, never the url the
   * browser happened to call: the gateway may be reached under another name
   * than the one the identity provider knows.
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
        `token exchange failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Validates a JWT: signature, issuer, audience and expiry.
   */
  async verifyToken(token: string, options: { nonce?: string } = {}): Promise<VerifiedIdentity> {
    const configuration = await this.metadata()
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, this.#keys(configuration), {
        issuer: configuration.serverMetadata().issuer,
        audience: this.audience,
        algorithms: ['RS256', 'ES256', 'RS384', 'RS512', 'ES384', 'PS256'],
        clockTolerance: 5,
      })
      payload = verified.payload
    } catch (error) {
      throw new OidcError(
        'token_invalid',
        `token validation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!payload.sub) {
      throw new OidcError('token_invalid', 'token does not contain a subject')
    }
    if (options.nonce && payload.nonce !== options.nonce) {
      throw new OidcError('token_invalid', 'token nonce does not match the authentication request')
    }
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      roles: extractRoles(payload, this.rolesClaim),
    }
  }

  /** Creates a fresh PKCE verifier/challenge pair plus state and nonce. */
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
}
