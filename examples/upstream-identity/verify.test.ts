import { describe, expect, test } from 'bun:test'
import { createPublicKey } from 'node:crypto'
import { importSPKI } from 'jose'
import { asymmetricIdentityKey, signIdentity } from '../../src/domains/forwarding'
import { canonicalPayload, identityOf, verifyIdentity } from './verify'

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
  createPublicKey(asymmetricIdentityKey(PRIVATE_KEY).key as never).export({
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

describe('the identity of a request, as an upstream verifies it', () => {
  test('the payload of the gateway and the one of the upstream are the same', async () => {
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const version = signature.slice(0, signature.indexOf('='))
    const headers = {
      'x-shuttle-user': identity.subject,
      'x-shuttle-email': identity.email,
      'x-shuttle-roles': identity.roles.join(','),
      'x-shuttle-workspace': identity.workspaceId,
      'x-shuttle-signature': signature,
    }
    // The upstream rebuilds the payload from the headers it received.
    expect(canonicalPayload(identityOf(headers), request, version)).toBe(
      canonicalPayload(identity, request, version)
    )
  })

  test('an upstream verifies the signature of the gateway', async () => {
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const result = await verifyIdentity({
      request,
      headers: {
        'x-shuttle-user': identity.subject,
        'x-shuttle-email': identity.email,
        'x-shuttle-roles': identity.roles.join(','),
        'x-shuttle-workspace': identity.workspaceId,
        'x-shuttle-signature': signature,
      },
      publicKey,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe('v5')
    expect(result.identity.subject).toBe('user-1')
    expect(result.identity.roles).toEqual(['admin', 'dev'])
    expect(result.identity.workspaceId).toBe('11111111-1111-4111-8111-111111111111')
  })

  test('an identity that was changed does not verify', async () => {
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const result = await verifyIdentity({
      request,
      headers: {
        'x-shuttle-user': 'another-user',
        'x-shuttle-email': identity.email,
        'x-shuttle-roles': identity.roles.join(','),
        'x-shuttle-workspace': identity.workspaceId,
        'x-shuttle-signature': signature,
      },
      publicKey,
    })
    expect(result.ok).toBe(false)
  })

  test('a request of another path does not verify', async () => {
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const result = await verifyIdentity({
      request: { ...request, path: '/v1/other' },
      headers: {
        'x-shuttle-user': identity.subject,
        'x-shuttle-email': identity.email,
        'x-shuttle-roles': identity.roles.join(','),
        'x-shuttle-workspace': identity.workspaceId,
        'x-shuttle-signature': signature,
      },
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
    const signing = asymmetricIdentityKey(PRIVATE_KEY)
    const signature = await signIdentity(identity, request, signing)
    const result = await verifyIdentity({
      request,
      headers: {
        'x-shuttle-user': identity.subject,
        'x-shuttle-email': identity.email,
        'x-shuttle-roles': identity.roles.join(','),
        'x-shuttle-workspace': identity.workspaceId,
        'x-shuttle-signature': signature,
      },
      publicKey: await importSPKI(
        createPublicKey(asymmetricIdentityKey(OTHER_KEY).key as never).export({
          type: 'spki',
          format: 'pem',
        }),
        'ES256'
      ),
    })
    expect(result.ok).toBe(false)
  })
})
