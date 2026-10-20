import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { OidcClient, OidcError } from '../src/auth/oidc'

let issuer: string
let keys: CryptoKey
let jwk: JWK
let otherKeys: CryptoKey
let server: ReturnType<typeof Bun.serve>

const CLIENT_ID = 'shuttle'

async function sign(options: {
  issuer?: string
  audience?: string
  expiresIn?: string
  subject?: string
  key?: CryptoKey
  nonce?: string
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const expiry = options.expiresIn === 'expired' ? now - 60 : now + 300
  return new SignJWT({ email: 'alice@shuttle.test', roles: ['admin'], nonce: options.nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setSubject(options.subject ?? 'user-alice')
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(expiry)
    .sign(options.key ?? keys)
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  keys = pair.privateKey
  jwk = await exportJWK(pair.publicKey)
  jwk.kid = 'test-key'
  jwk.alg = 'RS256'
  const other = await generateKeyPair('RS256')
  otherKeys = other.privateKey

  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: `http://localhost:${server.port}`,
          authorization_endpoint: `http://localhost:${server.port}/authorize`,
          token_endpoint: `http://localhost:${server.port}/token`,
          jwks_uri: `http://localhost:${server.port}/jwks`,
        })
      }
      if (url.pathname === '/jwks') {
        return Response.json({ keys: [jwk] })
      }
      return new Response('not found', { status: 404 })
    },
  })
  issuer = `http://localhost:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
})

function client(options: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}): OidcClient {
  return new OidcClient({
    issuer,
    clientId: CLIENT_ID,
    redirectUri: 'http://localhost:9999/auth/callback',
    // The test provider is served over plain http.
    allowInsecureIssuer: true,
    ...options,
  })
}

describe('oidc client', () => {
  test('validates issuer, audience, signature and expiry', async () => {
    const identity = await client().verifyToken(await sign({}))
    expect(identity.subject).toBe('user-alice')
    expect(identity.email).toBe('alice@shuttle.test')
    expect(identity.roles).toEqual(['admin'])
  })

  test('rejects a token with a different audience', async () => {
    await expect(
      client().verifyToken(await sign({ audience: 'some-other-client' }))
    ).rejects.toThrow(OidcError)
  })

  test('rejects a token with a different issuer', async () => {
    await expect(
      client().verifyToken(await sign({ issuer: 'https://evil.example.com' }))
    ).rejects.toThrow(OidcError)
  })

  test('rejects an expired token', async () => {
    await expect(client().verifyToken(await sign({ expiresIn: 'expired' }))).rejects.toThrow(
      OidcError
    )
  })

  test('rejects a token signed with another key', async () => {
    await expect(
      client().verifyToken(await sign({ key: otherKeys }))
    ).rejects.toThrow(OidcError)
  })

  test('rejects a token with a mismatching nonce', async () => {
    await expect(
      client().verifyToken(await sign({ nonce: 'other' }), { nonce: 'expected' })
    ).rejects.toThrow(OidcError)
  })

  test('rejects a provider whose issuer does not match', async () => {
    const mismatched = new OidcClient({
      issuer: 'http://localhost:1/other',
      clientId: CLIENT_ID,
      redirectUri: 'http://localhost:9999/auth/callback',
      allowInsecureIssuer: true,
    })
    await expect(mismatched.metadata()).rejects.toThrow(OidcError)
  })
})
