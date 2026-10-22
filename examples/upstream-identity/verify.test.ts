import { describe, expect, test } from 'bun:test'
import { createHmac, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CompactSign, importSPKI } from 'jose'
import { asymmetricIdentityKey, signIdentity } from '../../src/domains/forwarding'
import type { UpstreamHeaders, UpstreamRequest } from './verify'
import {
  canonicalPayload,
  identityOf,
  SIGNATURE_TYPE,
  SUPPORTED_VERSION,
  verifyIdentity,
} from './verify'

/**
 * The contract between the gateway and its upstreams.
 *
 * The implementation of the verification that an upstream writes is
 * **independent** of the one of the gateway: it rebuilds the payload from
 * the specification. The test signs with the key of the gateway and
 * verifies with the implementation of the upstream, so a change of the
 * format that breaks the contract of the upstreams fails the build.
 */
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkuKN/9wk9hJs4TsF
NEjHkj8cclKv3iB9nR7vgKkcwEOhRANCAAQ8bXaNL1nQ4xpQjNBEpjn29oDvta7R
EzXd+ms2kvgMosNye7/tEJyT6IsXi7zYekkcpLuM32a9AOSHPD/t2JPs
-----END PRIVATE KEY-----`

const publicKey = await importSPKI(
  createPublicKey(asymmetricIdentityKey(PRIVATE_KEY).key as KeyObject).export({
    type: 'spki',
    format: 'pem',
  }),
  'ES256'
)

const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgm8Zn19s4YS7acUM4
HFOT2BicftfMfQXJwmIBquIjUD2hRANCAAQaJ0QyywD+sKyASmHfxrmwBm/YyAsT
DlGoyiUmXDOgE8FcIlMVlFdh1sB8zPcoJIFb6BDwST2W869wEwkFwcVE
-----END PRIVATE KEY-----`

const request = {
  method: 'GET',
  path: '/v1/workspaces/11111111-1111-4111-8111-111111111111/assets',
  query: '?x=1',
  host: 'api.example.com',
}

const identity = {
  subject: 'user-1',
  email: 'user@example.com',
  roles: ['admin', 'dev'],
  workspaceId: '11111111-1111-4111-8111-111111111111',
}

/** The secret of the deployment of the tests. */
const SECRET = 'test-secret'

/**
 * A symmetric key, of the kind the removed format used.
 *
 * It is built here and not taken from the gateway: the format it belongs
 * to is removed, and the verifier has to refuse it.
 */
const symmetricKey = createHmac('sha256', SECRET).update('legacy').digest()

/** The headers of a request that carries the identity and its signature. */
function headersOf(signature: string, overrides: Partial<UpstreamHeaders> = {}): UpstreamHeaders {
  return {
    'x-shuttle-user': identity.subject,
    'x-shuttle-email': identity.email,
    'x-shuttle-roles': identity.roles.join(','),
    'x-shuttle-workspace': identity.workspaceId,
    'x-shuttle-signature': signature,
    ...overrides,
  }
}

/** The signature of the gateway, in the version of the release. */
async function v5Signature(): Promise<string> {
  return signIdentity(identity, request, asymmetricIdentityKey(PRIVATE_KEY))
}

/**
 * The signature of the removed symmetric format.
 *
 * It is built here, with a symmetric key, because the gateway does not
 * sign that format any more.
 */
async function v4Signature(): Promise<string> {
  const signed = new TextEncoder().encode('{"v":"v4"}')
  const jws = await new CompactSign(signed)
    .setProtectedHeader({ alg: 'HS256', typ: SIGNATURE_TYPE })
    .sign(symmetricKey)
  const [protectedHeader, , signature] = jws.split('.')
  return `v4=${protectedHeader}..${signature}`
}

/** A compact serialization with a protected header of the test. */
async function compactWith(
  header: Record<string, unknown>,
  key: Parameters<CompactSign['sign']>[0]
): Promise<string> {
  const jws = await new CompactSign(new TextEncoder().encode('payload'))
    .setProtectedHeader(header)
    .sign(key)
  const [protectedHeader, , signature] = jws.split('.')
  return `${protectedHeader}..${signature}`
}

describe('the identity of a request, as an upstream verifies it', () => {
  test('the payload of the gateway and the one of the upstream are the same', async () => {
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const version = signature.slice(0, signature.indexOf('='))
    const headers = headersOf(signature)
    // The upstream rebuilds the payload from the headers it received.
    expect(canonicalPayload(identityOf(headers), request, version)).toBe(
      canonicalPayload(identity, request, version)
    )
  })

  test('an upstream verifies the signature of the gateway', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe(SUPPORTED_VERSION)
    expect(result.identity.subject).toBe('user-1')
    expect(result.identity.roles).toEqual(['admin', 'dev'])
    expect(result.identity.workspaceId).toBe('11111111-1111-4111-8111-111111111111')
  })

  test('an identity that was changed does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature, { 'x-shuttle-user': 'another-user' }),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request of another path does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request: { ...request, path: '/v1/other' },
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request of another method does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request: { ...request, method: 'DELETE' },
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request of another query does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request: { ...request, query: '?x=2' },
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request of another host does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request: { ...request, host: 'other.example.com' },
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('an identity of another workspace does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature, {
        'x-shuttle-workspace': '22222222-2222-4222-8222-222222222222',
      }),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('an identity of another role does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature, { 'x-shuttle-roles': 'admin,other' }),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request without a signature is refused', async () => {
    const result = await verifyIdentity({
      request,
      headers: { 'x-shuttle-user': identity.subject },
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a signature of another key does not verify', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature),
      publicKey: await importSPKI(
        createPublicKey(asymmetricIdentityKey(OTHER_KEY).key).export({
          type: 'spki',
          format: 'pem',
        }),
        'ES256'
      ),
    })
    expect(result.ok).toBe(false)
  })
})

describe('the combination the verifier accepts', () => {
  test('a version that is not known is refused', async () => {
    const signature = await v5Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature.replace(`${SUPPORTED_VERSION}=`, 'v9=')),
      publicKey,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v9')
  })

  test('a signature of another algorithm is refused', async () => {
    // The signature is a real one, but it is signed with the symmetric
    // algorithm and it claims to be of the version of the release.
    const serialized = await compactWith({ alg: 'HS256', typ: SIGNATURE_TYPE }, symmetricKey)
    const result = await verifyIdentity({
      request,
      headers: headersOf(`${SUPPORTED_VERSION}=${serialized}`),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a signature of another type is refused', async () => {
    const serialized = await compactWith(
      { alg: 'ES256', typ: 'something-else' },
      asymmetricIdentityKey(PRIVATE_KEY).key as Parameters<CompactSign['sign']>[0]
    )
    const result = await verifyIdentity({
      request,
      headers: headersOf(`${SUPPORTED_VERSION}=${serialized}`),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a protected header without a type is refused', async () => {
    const serialized = await compactWith(
      { alg: 'ES256' },
      asymmetricIdentityKey(PRIVATE_KEY).key as Parameters<CompactSign['sign']>[0]
    )
    const result = await verifyIdentity({
      request,
      headers: headersOf(`${SUPPORTED_VERSION}=${serialized}`),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a public key of another curve is refused', async () => {
    const { publicKey: p384 } = generateKeyPairSync('ec', { namedCurve: 'P-384' })
    const result = await verifyIdentity({
      request,
      headers: headersOf(await v5Signature()),
      publicKey: p384,
    })
    expect(result.ok).toBe(false)
  })

  test('a private key is refused', async () => {
    const result = await verifyIdentity({
      request,
      headers: headersOf(await v5Signature()),
      publicKey: asymmetricIdentityKey(PRIVATE_KEY).key,
    })
    expect(result.ok).toBe(false)
  })
})

describe('the serialization the verifier refuses', () => {
  test('a signature that is not a compact serialization is refused', async () => {
    for (const malformed of ['not-a-signature', 'a.b', 'a.b.c.d', `${SUPPORTED_VERSION}=`, 'v5=..']) {
      const result = await verifyIdentity({
        request,
        headers: headersOf(malformed),
        publicKey,
      })
      expect(result.ok).toBe(false)
    }
  })

  test('a signature that carries a payload is refused', async () => {
    const signature = await v5Signature()
    const parts = signature.slice(signature.indexOf('=') + 1).split('.')
    const withPayload = `${SUPPORTED_VERSION}=${parts[0]}.${Buffer.from('{}').toString('base64url')}.${parts[2]}`
    const result = await verifyIdentity({
      request,
      headers: headersOf(withPayload),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a protected header that is not base64url is refused', async () => {
    const signature = await v5Signature()
    const parts = signature.slice(signature.indexOf('=') + 1).split('.')
    const malformed = `${SUPPORTED_VERSION}=not base64!.${parts[2]}`
    const result = await verifyIdentity({
      request,
      headers: headersOf(malformed),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a protected header that is not json is refused', async () => {
    const signature = await v5Signature()
    const parts = signature.slice(signature.indexOf('=') + 1).split('.')
    const malformed = `${SUPPORTED_VERSION}=${Buffer.from('not json').toString('base64url')}.${parts[2]}`
    const result = await verifyIdentity({
      request,
      headers: headersOf(malformed),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })
})

describe('the removed symmetric format', () => {
  test('a signature of it is refused', async () => {
    const signature = await v4Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('v4')
  })

  test('a signature of it that claims the version of the release is refused', async () => {
    const signature = await v4Signature()
    const result = await verifyIdentity({
      request,
      headers: headersOf(signature.replace('v4=', `${SUPPORTED_VERSION}=`)),
      publicKey,
    })
    expect(result.ok).toBe(false)
  })
})

describe('the reference verifier', () => {
  test('it imports nothing of the gateway', async () => {
    const source = await readFile(
      resolve(import.meta.dir, 'verify.ts'),
      'utf8'
    )
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!)
    for (const specifier of imports) {
      expect(specifier.startsWith('.')).toBe(false)
    }
    expect(imports).toEqual(['jose'])
  })

  test('it reads the identity of the headers as the gateway writes it', () => {
    const headers = headersOf('v5=whatever')
    expect(identityOf(headers)).toEqual({
      subject: 'user-1',
      email: 'user@example.com',
      roles: ['admin', 'dev'],
      workspaceId: '11111111-1111-4111-8111-111111111111',
    })
  })

  test('the request it verifies is the one the upstream received', async () => {
    // The path and the query are the raw ones of the request line: the
    // upstream does not decode them before it rebuilds the payload.
    const raw: UpstreamRequest = {
      method: 'get',
      path: '/v1/a%20b',
      query: '?x=1&y=%20',
      host: 'API.example.com',
    }
    const signature = await signIdentity(
      { ...identity },
      { method: 'GET', path: raw.path, query: raw.query, host: 'api.example.com' },
      asymmetricIdentityKey(PRIVATE_KEY)
    )
    const result = await verifyIdentity({
      request: raw,
      headers: headersOf(signature),
      publicKey,
    })
    expect(result.ok).toBe(true)
  })
})
