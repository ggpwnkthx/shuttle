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
  const sign = async (claims: Record<string, unknown>, options: { expiresIn?: string } = {}) => {
    const key = await importJWK(provider.privateJwk, 'RS256')
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: provider.privateJwk.kid })
      .setIssuedAt()
      .setIssuer(provider.issuer)
      .setAudience(provider.clientId)
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(key)
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
