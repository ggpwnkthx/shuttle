/**
 * Minimal type declarations for `oidc-provider`.
 *
 * The package does not ship type declarations of its own, so the parts that
 * the development identity provider uses are declared here.
 */
declare module 'oidc-provider' {
  export interface OidcProviderPromptDetails {
    missingOIDCScope?: string[]
    missingOIDCClaims?: string[]
  }

  export interface OidcProviderInteractionDetails {
    uid: string
    prompt: {
      name: string
      details: OidcProviderPromptDetails
    }
    params: Record<string, string>
    session?: { accountId?: string }
    grantId?: string
  }

  export interface OidcProviderGrant {
    addOIDCScope(scope: string): void
    addOIDCClaims(claims: string[]): void
    save(): Promise<string>
  }

  export interface OidcProviderContext {
    path: string
    method: string
    req: unknown
    res: unknown
    status: number
    type: string
    body: unknown
    request: { body?: unknown }
  }

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>)
    /** The grant model, used to pre-grant the consent. */
    Grant: new (options: { accountId: string; clientId: string }) => OidcProviderGrant
    /** Starts the provider, the arguments are passed to `http.Server.listen`. */
    listen(...args: unknown[]): unknown
    /** The request handler of the provider, for use with `http.createServer`. */
    callback(): (req: unknown, res: unknown) => void
    /** Adds a middleware that runs before the routes of the provider. */
    use(fn: (ctx: OidcProviderContext, next: () => Promise<void>) => unknown): this
    interactionDetails(req: unknown, res: unknown): Promise<OidcProviderInteractionDetails>
    interactionFinished(
      req: unknown,
      res: unknown,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean }
    ): Promise<void>
  }
}
