import { describe, expect, test } from 'bun:test'
import { SignJWT, importJWK } from 'jose'
import { OidcClient, OidcError, extractRoles } from '../../src/domains/authentication'
import { startOidcProvider, type StartedOidcProvider } from '../../services/oidc-provider'

/**
 * The relying party, against a real provider.
 *
 * The validation of a token is the security boundary of the api clients of
 * the platform: a token that is expired, that has the wrong audience, that
 * was signed by another key or that has no subject must never authenticate
 * a caller.
 */
describe('the identity provider', () => {
  let provider: StartedOidcProvider
  let client: OidcClient

  const start = async (): Promise<void> => {
    provider = await startOidcProvider({ redirectUris: ['http://localhost:8080/auth/callback'] })
    client = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      rolesClaim: 'roles',
    })
  }

  /** Signs a token with the key of the provider. */
  const sign = async (
    claims: Record<string, unknown>,
    options: { expiresIn?: string | null } = {}
  ) => {
    const key = await importJWK(provider.privateJwk, 'RS256')
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: provider.privateJwk.kid })
      .setIssuedAt()
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
    // A token without an expiry is signed as it is: the claim is not set
    // at all, so the token carries no `exp`.
    if (options.expiresIn !== null) {
      builder.setExpirationTime(options.expiresIn ?? '5m')
    }
    return await builder.sign(key)
  }

  test('the metadata of the provider is discovered', async () => {
    await start()
    const metadata = await client.metadata()
    expect(metadata.serverMetadata().issuer).toBe(provider.issuer)
    await provider.stop()
  })

  test('a provider that names another issuer is refused', async () => {
    await start()
    const other = new OidcClient({
      issuer: `${provider.issuer}/other`,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
    })
    await expect(other.metadata()).rejects.toThrow()
    await provider.stop()
  })

  test('a valid token authenticates the caller', async () => {
    await start()
    const token = await sign({
      sub: 'user-1',
      email: 'user@example.com',
      roles: ['admin', 'member'],
    })
    const identity = await client.verifyToken(token)
    expect(identity.subject).toBe('user-1')
    expect(identity.email).toBe('user@example.com')
    expect(identity.roles).toEqual(['admin', 'member'])
    await provider.stop()
  })

  test('a token that is expired is refused', async () => {
    await start()
    const token = await sign({ sub: 'user-1' }, { expiresIn: '-1h' })
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('a token with the wrong audience is refused', async () => {
    await start()
    const key = await importJWK(provider.privateJwk, 'RS256')
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: provider.privateJwk.kid })
      .setIssuedAt()
      .setIssuer(provider.issuer)
      .setAudience('another-client')
      .setExpirationTime('5m')
      .sign(key)
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('a token without a subject is refused', async () => {
    await start()
    const token = await sign({ email: 'user@example.com' })
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('an id token is refused as a bearer token', async () => {
    await start()
    // The browser flow of the gateway always asks for a nonce, so an id
    // token of this client always carries one. An id token travels through
    // the browser: it must not authenticate an api client.
    const token = await sign({ sub: 'user-1', nonce: 'the-nonce-of-the-login' })
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await expect(client.verifyToken(token)).rejects.toThrow(/id token/)
    await provider.stop()
  })

  test('an id token is accepted when it is verified against its nonce', async () => {
    await start()
    const token = await sign({ sub: 'user-1', nonce: 'the-nonce-of-the-login' })
    const identity = await client.verifyToken(token, { nonce: 'the-nonce-of-the-login' })
    expect(identity.subject).toBe('user-1')
    await provider.stop()
  })

  test('a provider whose access tokens carry a nonce turns the check off', async () => {
    await start()
    const lenient = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      rejectNonceTokens: false,
    })
    const token = await sign({ sub: 'user-1', nonce: 'a-nonce' })
    const identity = await lenient.verifyToken(token)
    expect(identity.subject).toBe('user-1')
    await provider.stop()
  })

  test('a token that does not carry a required claim is refused', async () => {
    await start()
    const strict = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      requiredTokenClaims: ['scp'],
    })
    const without = await sign({ sub: 'user-1' })
    await expect(strict.verifyToken(without)).rejects.toThrow(OidcError)
    await expect(strict.verifyToken(without)).rejects.toThrow(/scp/)
    const with_ = await sign({ sub: 'user-1', scp: 'read' })
    expect((await strict.verifyToken(with_)).subject).toBe('user-1')
    await provider.stop()
  })

  test('a token that was signed by another key is refused', async () => {
    await start()
    const key = await importJWK(provider.privateJwk, 'RS256')
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'another-key' })
      .setIssuedAt()
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
      .setExpirationTime('5m')
      .sign(key)
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('a token without an expiry is refused', async () => {
    await start()
    // The library checks the expiry **when the token carries one**: a
    // token without an `exp` claim passes the validation of the signature
    // and of the issuer, and it is valid forever. A credential that
    // nobody can revoke is not a credential.
    const token = await sign({ sub: 'user-1' }, { expiresIn: null })
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await expect(client.verifyToken(token)).rejects.toThrow(/expiry/)
    await provider.stop()
  })

  test('a token that is valid for longer than the bound is refused', async () => {
    await start()
    const bounded = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      // The bound of the lifetime of a token: it is what turns the removal
      // of a caller from the provider into a bounded delay.
      maxTokenAgeMs: 600_000,
    })
    const long = await sign({ sub: 'user-1' }, { expiresIn: '30d' })
    await expect(bounded.verifyToken(long)).rejects.toThrow(OidcError)
    await expect(bounded.verifyToken(long)).rejects.toThrow(/maximum/)
    // A token that fits in the bound is accepted.
    const short = await sign({ sub: 'user-1' }, { expiresIn: '5m' })
    expect((await bounded.verifyToken(short)).subject).toBe('user-1')
    await provider.stop()
  })

  test('a token that was issued long ago is refused even when it is close to its expiry', async () => {
    await start()
    const bounded = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      maxTokenAgeMs: 600_000,
    })
    // The token was issued a day ago and it is valid for another minute:
    // the validity that is left fits in the bound, and the lifetime does
    // not. The bound is on the lifetime.
    const key = await importJWK(provider.privateJwk, 'RS256')
    const issuedAt = Math.floor(Date.now() / 1000) - 86_400
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: provider.privateJwk.kid })
      .setIssuedAt(issuedAt)
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
      .setExpirationTime(issuedAt + 60)
      .sign(key)
    await expect(bounded.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('a token that does not carry the moment it was issued is refused when the bound is on', async () => {
    await start()
    const bounded = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      maxTokenAgeMs: 600_000,
    })
    const key = await importJWK(provider.privateJwk, 'RS256')
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: provider.privateJwk.kid })
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
      .setExpirationTime('5m')
      .sign(key)
    await expect(bounded.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('the bound of the lifetime of a token can be turned off', async () => {
    await start()
    const unbounded = new OidcClient({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
      maxTokenAgeMs: 0,
    })
    const long = await sign({ sub: 'user-1' }, { expiresIn: '30d' })
    expect((await unbounded.verifyToken(long)).subject).toBe('user-1')
    // The bound is off, and the expiry is still required: a token that
    // never expires is refused whatever the bound is.
    const withoutExpiry = await sign({ sub: 'user-1' }, { expiresIn: null })
    await expect(unbounded.verifyToken(withoutExpiry)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('the roles are read from the claim of the deployment', async () => {
    await start()
    expect(extractRoles({ roles: ['a', 'b'] }, 'roles')).toEqual(['a', 'b'])
    expect(extractRoles({ roles: 'a,b c' }, 'roles')).toEqual(['a', 'b', 'c'])
    expect(extractRoles({ roles: 42 }, 'roles')).toEqual([])
    expect(extractRoles({}, 'roles')).toEqual([])
  })

  test('the keys of the provider are rotated', async () => {
    await start()
    const token = await sign({ sub: 'user-1' })
    expect((await client.verifyToken(token)).subject).toBe('user-1')

    await provider.rotateKeys()
    // A token of the new key is accepted: the set of the keys of the
    // provider is fetched again when it does not know the key of a token.
    const fresh = await sign({ sub: 'user-2' })
    expect((await client.verifyToken(fresh)).subject).toBe('user-2')
    await provider.stop()
  })

  test('a token of a key the provider does not know is refused', async () => {
    await start()
    const { generateKeyPair, exportJWK } = await import('jose')
    const { privateKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk = await exportJWK(privateKey)
    const key = await importJWK(jwk, 'RS256')
    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'a-key-the-provider-does-not-know' })
      .setIssuedAt()
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
      .setExpirationTime('5m')
      .sign(key)
    await expect(client.verifyToken(token)).rejects.toThrow(OidcError)
    await provider.stop()
  })

  test('a provider that cannot be reached is a bounded failure', async () => {
    const offline = new OidcClient({
      issuer: 'http://127.0.0.1:1',
      clientId: 'shuttle',
      redirectUri: 'http://localhost:8080/auth/callback',
      allowInsecureIssuer: true,
    })
    await expect(offline.verifyToken('a-token')).rejects.toThrow(OidcError)
  })
})
