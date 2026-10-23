import { describe, expect, test } from 'bun:test'
import { CompactSign, compactVerify } from 'jose'
import {
  asymmetricIdentityKey,
  canonicalIdentityPayload,
  ephemeralIdentityKey,
  publicKeyPem,
  sanitizeIdentityValue,
  signIdentity,
  verificationKeyOf,
  verifyIdentity,
  writtenIdentity,
  type SignedRequest,
  type WrittenIdentity,
} from './index'

/**
 * The private key of the deployment of the tests.
 *
 * It is a key of the curve P-256, and it is the same in every test of the
 * file: the signature of the identity is asymmetric, so the signature of a
 * request is never the same twice and only the payload of it is pinned.
 */
const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkuKN/9wk9hJs4TsF
NEjHkj8cclKv3iB9nR7vgKkcwEOhRANCAAQ8bXaNL1nQ4xpQjNBEpjn29oDvta7R
EzXd+ms2kvgMosNye7/tEJyT6IsXi7zYekkcpLuM32a9AOSHPD/t2JPs
-----END PRIVATE KEY-----`

/** Another private key of the curve P-256, of another deployment. */
const otherPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgm8Zn19s4YS7acUM4
HFOT2BicftfMfQXJwmIBquIjUD2hRANCAAQaJ0QyywD+sKyASmHfxrmwBm/YyAsT
DlGoyiUmXDOgE8FcIlMVlFdh1sB8zPcoJIFb6BDwST2W869wEwkFwcVE
-----END PRIVATE KEY-----`

/**
 * The signature of the identity.
 *
 * The vector of the specification is pinned here: an upstream that verifies
 * the signature of the identity has to arrive at the same payload, and a
 * change of the canonical form is a change of the contract.
 *
 * The signature itself is not pinned: it is an `ES256` one, and the
 * signature of the same request is never the same twice. What is pinned is
 * the payload, the protected header and the fact that the signature
 * verifies with the public key of the deployment.
 */
describe('the signature of the identity', () => {
  const signing = asymmetricIdentityKey(privateKeyPem)
  const verification = verificationKeyOf(signing)
  const claims = {
    subject: 'user-1',
    email: 'user@example.com',
    roles: ['admin', 'dev'],
    workspaceId: '11111111-1111-4111-8111-111111111111',
  }
  const request: SignedRequest = {
    method: 'GET',
    path: '/base/ws/123',
    query: '?x=1',
    host: 'api.example.com',
  }

  test('the canonical payload is the one of the specification', () => {
    const identity: WrittenIdentity = {
      subject: claims.subject,
      email: claims.email,
      roles: claims.roles,
      workspaceId: claims.workspaceId,
    }
    expect(canonicalIdentityPayload(identity, request)).toBe(
      '{"v":"v5","method":"GET","path":"/base/ws/123","query":"?x=1","host":"api.example.com","subject":"user-1","workspaceId":"11111111-1111-4111-8111-111111111111","email":"user@example.com","roles":["admin","dev"]}'
    )
  })

  test('the signature is a detached jws', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const signature = await signIdentity(identity, request, signing)
    const parts = signature.slice('v5='.length).split('.')
    // The payload is detached: the segment in the middle is empty.
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe('')
    // The protected header names the algorithm and the type of the signature.
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      alg: string
      typ: string
    }
    expect(header.alg).toBe('ES256')
    expect(header.typ).toBe('shuttle-identity')
  })

  test('the protected header is the one of the specification', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const signature = await signIdentity(identity, request, signing)
    const [protectedHeader] = signature.slice('v5='.length).split('.')
    expect(protectedHeader).toBe('eyJhbGciOiJFUzI1NiIsInR5cCI6InNodXR0bGUtaWRlbnRpdHkifQ')
  })

  test('an upstream verifies the signature with the standard library', async () => {
    // The upstream rebuilds the payload from the request and from the
    // identity headers, rebuilds the compact serialization around it and
    // verifies the signature: a signature that does not belong to the
    // request is refused by the verification itself.
    const identity: WrittenIdentity = {
      subject: claims.subject,
      email: claims.email,
      roles: claims.roles,
      workspaceId: claims.workspaceId,
    }
    const signature = await signIdentity(identity, request, signing)
    const [protectedHeader, , detachedSignature] = signature.slice('v5='.length).split('.')
    const payload = Buffer.from(canonicalIdentityPayload(identity, request), 'utf8').toString(
      'base64url'
    )
    const compact = `${protectedHeader}.${payload}.${detachedSignature}`
    const publicKey = verification.key
    const verified = await compactVerify(compact, publicKey, { algorithms: ['ES256'] })
    expect(Buffer.from(verified.payload).toString('utf8')).toBe(
      canonicalIdentityPayload(identity, request)
    )
    // The payload of another request does not verify.
    const other = `${protectedHeader}.${Buffer.from(
      canonicalIdentityPayload(identity, { ...request, path: '/other' }),
      'utf8'
    ).toString('base64url')}.${detachedSignature}`
    await expect(compactVerify(other, publicKey, { algorithms: ['ES256'] })).rejects.toThrow()
  })

  test('the order of the roles is not part of the meaning', () => {
    const identity: WrittenIdentity = {
      subject: claims.subject,
      email: claims.email,
      roles: ['dev', 'admin'],
      workspaceId: claims.workspaceId,
    }
    expect(canonicalIdentityPayload(identity, request)).toBe(
      canonicalIdentityPayload({ ...identity, roles: ['admin', 'dev'] }, request)
    )
  })

  test('the host is compared in lower case', () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const lower = canonicalIdentityPayload(identity, { ...request, host: 'api.example.com' })
    const upper = canonicalIdentityPayload(identity, { ...request, host: 'API.EXAMPLE.COM' })
    expect(lower).toBe(upper)
  })

  test('a signature that belongs to another request is refused', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const signature = await signIdentity(identity, request, signing)
    expect(
      await verifyIdentity(identity, { ...request, query: '?x=2' }, verification, signature)
    ).toBe(false)
    expect(
      await verifyIdentity(identity, { ...request, path: '/other' }, verification, signature)
    ).toBe(false)
    expect(
      await verifyIdentity(identity, { ...request, method: 'POST' }, verification, signature)
    ).toBe(false)
    expect(await verifyIdentity(identity, request, verification, signature)).toBe(true)
  })

  test('a signature of another key is refused', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const signature = await signIdentity(
      identity,
      request,
      asymmetricIdentityKey(otherPrivateKeyPem)
    )
    expect(await verifyIdentity(identity, request, verification, signature)).toBe(false)
  })

  test('a missing or a malformed signature is refused', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    expect(await verifyIdentity(identity, request, verification, null)).toBe(false)
    expect(await verifyIdentity(identity, request, verification, 'v5=short')).toBe(false)
    expect(await verifyIdentity(identity, request, verification, 'v2=00')).toBe(false)
    // The signature of the previous format is not a signature of this one.
    expect(
      await verifyIdentity(
        identity,
        request,
        verification,
        'v3=d10099233a754d22506db9d4a8d397bb8f58c0cbfe93f2782309eea1c49c7e4c'
      )
    ).toBe(false)
    // The symmetric format of the earlier releases is removed: a `v4`
    // signature is refused like the signature of any unknown version.
    expect(
      await verifyIdentity(
        identity,
        request,
        verification,
        'v4=eyJhbGciOiJIUzI1NiIsInR5cCI6InNodXR0bGUtaWRlbnRpdHkifQ..tIL7qgT7uQOhaHjjFpgmOHYSAcjNBrddkreDMFejQm8'
      )
    ).toBe(false)
  })

  test('a signature of another type or with a payload is refused', async () => {
    const identity: WrittenIdentity = { subject: claims.subject, roles: claims.roles }
    const signed = new TextEncoder().encode(canonicalIdentityPayload(identity, request))
    // The protected header names another type: the signature is of another
    // kind and the upstream does not try to verify it.
    const other = await new CompactSign(signed)
      .setProtectedHeader({ alg: 'ES256', typ: 'something-else' })
      .sign(signing.key)
    const [otherHeader, , otherSignature] = other.split('.')
    expect(
      await verifyIdentity(identity, request, verification, `v5=${otherHeader}..${otherSignature}`)
    ).toBe(false)
    // The payload of the signature is detached: a signature that carries
    // one is not a signature of this format.
    const signature = await signIdentity(identity, request, signing)
    const [header, , detached] = signature.slice('v5='.length).split('.')
    const payload = Buffer.from('{}').toString('base64url')
    expect(
      await verifyIdentity(identity, request, verification, `v5=${header}.${payload}.${detached}`)
    ).toBe(false)
  })
})

describe('the identity that is written into the headers', () => {
  test('the control characters are removed', () => {
    expect(sanitizeIdentityValue('al ice')).toBe('alice')
    expect(sanitizeIdentityValue('al\nice')).toBe('alice')
    expect(sanitizeIdentityValue('alice')).toBe('alice')
    expect(sanitizeIdentityValue('alice')).toBe('alice')
  })

  test('the length is bounded', () => {
    expect(sanitizeIdentityValue('a'.repeat(1000))?.length).toBe(512)
  })

  test('a subject that is empty after the sanitization is refused', () => {
    expect(() => writtenIdentity({ subject: ' ', roles: [] })).toThrow()
    expect(() => writtenIdentity({ subject: '', roles: [] })).toThrow()
  })

  test('a subject that carries a control character is refused', () => {
    // The subject is the identity: it is never rewritten, because a
    // sanitization that removes a character of it turns two callers into
    // one.
    expect(() => writtenIdentity({ subject: 'ad\u0001min', roles: [] })).toThrow()
    expect(() => writtenIdentity({ subject: 'admin\n', roles: [] })).toThrow()
  })

  test('a subject that is too long is refused', () => {
    expect(() => writtenIdentity({ subject: 'a'.repeat(513), roles: [] })).toThrow()
    expect(writtenIdentity({ subject: 'a'.repeat(512), roles: [] }).subject).toHaveLength(512)
  })

  test('the subject is written as it is', () => {
    const identity = writtenIdentity({ subject: 'user-1', roles: [] })
    expect(identity.subject).toBe('user-1')
  })

  test('a role that would make the list ambiguous is dropped', () => {
    const identity = writtenIdentity({
      subject: 'user-1',
      roles: ['admin', 'a,b', 'dev', 'c\nd', ''],
    })
    expect(identity.roles).toEqual(['admin', 'dev'])
  })

  test('the email and the workspace are sanitized as well', () => {
    const identity = writtenIdentity({
      subject: 'user-1',
      email: 'us\ner@example.com',
      workspaceId: '1111 1111',
      roles: [],
    })
    expect(identity.email).toBe('user@example.com')
    expect(identity.workspaceId).toBe('11111111')
  })
})

/**
 * The key of the signature of the identity.
 *
 * The signature is asymmetric: the upstreams hold the **public** key, they
 * verify the identity of a request and they cannot mint one. The symmetric
 * format of the earlier releases is removed: its key was shared with the
 * upstreams, so an upstream that verified an identity could mint one as
 * well.
 */
describe('the key of the signature of the identity', () => {
  const identity: WrittenIdentity = {
    subject: 'user-1',
    email: 'user@example.com',
    roles: ['admin', 'dev'],
    workspaceId: '11111111-1111-4111-8111-111111111111',
  }
  const request: SignedRequest = {
    method: 'GET',
    path: '/base/ws/123',
    query: '?x=1',
    host: 'api.example.com',
  }

  test('the key of the deployment is a private key of the curve P-256', () => {
    const signing = asymmetricIdentityKey(privateKeyPem)
    expect(signing.version).toBe('v5')
    expect(signing.algorithm).toBe('ES256')
  })

  test('a key that is not a private key is refused', () => {
    expect(() => asymmetricIdentityKey('not a key')).toThrow(/private key/)
  })

  test('the signature carries the version of the format', async () => {
    const signing = asymmetricIdentityKey(privateKeyPem)
    const signature = await signIdentity(identity, request, signing)
    expect(signature.startsWith('v5=')).toBe(true)
    const [protectedHeader] = signature.slice('v5='.length).split('.')
    const header = JSON.parse(Buffer.from(protectedHeader!, 'base64url').toString('utf8')) as {
      alg: string
      typ: string
    }
    expect(header.alg).toBe('ES256')
    expect(header.typ).toBe('shuttle-identity')
  })

  test('an upstream verifies the signature with the public key', async () => {
    const signing = asymmetricIdentityKey(privateKeyPem)
    const signature = await signIdentity(identity, request, signing)
    // The upstream is given the public key: it verifies and it cannot mint.
    const publicKey = verificationKeyOf(signing)
    expect(await verifyIdentity(identity, request, publicKey, signature)).toBe(true)
  })

  test('the public key is what the upstreams are given', () => {
    const signing = asymmetricIdentityKey(privateKeyPem)
    const pem = publicKeyPem(signing)
    expect(pem).toContain('BEGIN PUBLIC KEY')
  })

  test('a key that is generated for the process signs the format of the release', async () => {
    const signing = ephemeralIdentityKey()
    expect(signing.version).toBe('v5')
    expect(signing.algorithm).toBe('ES256')
    const signature = await signIdentity(identity, request, signing)
    expect(await verifyIdentity(identity, request, verificationKeyOf(signing), signature)).toBe(
      true
    )
    // The key is of the process: another one does not verify its signature.
    const other = ephemeralIdentityKey()
    expect(await verifyIdentity(identity, request, verificationKeyOf(other), signature)).toBe(false)
  })

  test('a signature of another private key is refused', async () => {
    const signing = asymmetricIdentityKey(privateKeyPem)
    const signature = await signIdentity(
      identity,
      request,
      asymmetricIdentityKey(otherPrivateKeyPem)
    )
    expect(await verifyIdentity(identity, request, verificationKeyOf(signing), signature)).toBe(
      false
    )
  })
})
