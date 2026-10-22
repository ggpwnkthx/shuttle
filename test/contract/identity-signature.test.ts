import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from './harness'
import {
  asymmetricIdentityKey,
  canonicalIdentityPayload,
  verificationKeyOf,
  verifyIdentity,
  type WrittenIdentity,
} from '../../src/domains/forwarding'

/**
 * The signature of the identity, as an upstream sees it.
 *
 * The upstream rebuilds the payload from the request and from the identity
 * headers, rebuilds the compact serialization around it and verifies the
 * signature with the **public** key of the deployment.
 *
 * The signature is asymmetric: the gateway holds the private key and the
 * upstream holds the public one, so an upstream that verifies an identity
 * cannot mint one as well.
 */
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkuKN/9wk9hJs4TsF
NEjHkj8cclKv3iB9nR7vgKkcwEOhRANCAAQ8bXaNL1nQ4xpQjNBEpjn29oDvta7R
EzXd+ms2kvgMosNye7/tEJyT6IsXi7zYekkcpLuM32a9AOSHPD/t2JPs
-----END PRIVATE KEY-----`

let harness: Harness
let harnessWithoutKey: Harness

beforeAll(async () => {
  harness = await createHarness({ env: { SHUTTLE_IDENTITY_SIGNING_KEY: PRIVATE_KEY } })
  // The deployment without a key: the gateway signs with a key of its own
  // process (§7.4 of the specification).
  harnessWithoutKey = await createHarness()
})

afterAll(async () => {
  await harness.stop()
  await harnessWithoutKey.stop()
})

describe('the signature of the identity of a request', () => {
  test('the gateway signs with the private key of the deployment', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    const signature = body.headers['x-shuttle-signature'] ?? ''
    expect(signature).not.toBe('')
    expect(signature.startsWith('v5=')).toBe(true)
  })

  test('an upstream verifies the signature with the public key', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    const body = (await response.json()) as {
      headers: Record<string, string>
      target: string
    }
    const headers = body.headers
    // The target as the upstream received it: the path and the query string.
    const separator = body.target.indexOf('?')
    const path = separator === -1 ? body.target : body.target.slice(0, separator)
    const query = separator === -1 ? '' : body.target.slice(separator)

    // The identity the upstream reads from the headers it received.
    const identity: WrittenIdentity = {
      subject: headers['x-shuttle-user'] ?? '',
      email: headers['x-shuttle-email'],
      roles: (headers['x-shuttle-roles'] ?? '').split(',').filter((role) => role.length > 0),
      workspaceId: headers['x-shuttle-workspace'],
    }

    // The upstream holds the public key: it verifies and it cannot mint.
    const verification = verificationKeyOf(asymmetricIdentityKey(PRIVATE_KEY))
    const verified = await verifyIdentity(
      identity,
      {
        method: 'GET',
        path,
        query,
        host: headers['x-forwarded-host'] ?? '',
      },
      verification,
      headers['x-shuttle-signature']
    )
    expect(verified).toBe(true)
  })

  test('the payload the upstream rebuilds is the one of the specification', async () => {
    const token = await harness.token()
    const response = await fetch(`${harness.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`, {
      headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` },
    })
    const body = (await response.json()) as { headers: Record<string, string>; target: string }
    const separator = body.target.indexOf('?')
    const path = separator === -1 ? body.target : body.target.slice(0, separator)
    const query = separator === -1 ? '' : body.target.slice(separator)
    const headers = body.headers
    const identity: WrittenIdentity = {
      subject: headers['x-shuttle-user'] ?? '',
      email: headers['x-shuttle-email'],
      roles: (headers['x-shuttle-roles'] ?? '').split(',').filter((role) => role.length > 0),
      workspaceId: headers['x-shuttle-workspace'],
    }
    const payload = canonicalIdentityPayload(
      identity,
      {
        method: 'GET',
        path,
        query,
        host: headers['x-forwarded-host'] ?? '',
      },
      'v5'
    )
    expect(payload).toContain('"v":"v5"')
    expect(payload).toContain('"subject":"user-alice"')
  })
})

/**
 * The signature of the identity of a deployment without a key.
 *
 * The symmetric format is removed, so a deployment that has no
 * `SHUTTLE_IDENTITY_SIGNING_KEY` and is not a production one signs with a
 * key that is generated for its process: the format of the signature is
 * the same, but the key is neither shared by the replicas nor kept across
 * a restart, and no upstream can verify the identity.
 */
describe('the signature of the identity of a deployment without a key', () => {
  test('the gateway signs with the format of the release', async () => {
    const token = await harnessWithoutKey.token()
    const response = await fetch(
      `${harnessWithoutKey.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`,
      { headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    const signature = body.headers['x-shuttle-signature'] ?? ''
    expect(signature).not.toBe('')
    expect(signature.startsWith('v5=')).toBe(true)
    // The protected header names the algorithm and the type of the signature.
    const [protectedHeader] = signature.slice('v5='.length).split('.')
    const header = JSON.parse(Buffer.from(protectedHeader!, 'base64url').toString('utf8')) as {
      alg: string
      typ: string
    }
    expect(header.alg).toBe('ES256')
    expect(header.typ).toBe('shuttle-identity')
  })

  test('the key of the process does not verify with the key of the deployment', async () => {
    const token = await harnessWithoutKey.token()
    const response = await fetch(
      `${harnessWithoutKey.gatewayUrl}/ws/11111111-1111-4111-8111-111111111111/`,
      { headers: { host: 'api.shuttle.test', authorization: `Bearer ${token}` } }
    )
    const body = (await response.json()) as { headers: Record<string, string>; target: string }
    const headers = body.headers
    const separator = body.target.indexOf('?')
    const path = separator === -1 ? body.target : body.target.slice(0, separator)
    const query = separator === -1 ? '' : body.target.slice(separator)
    const identity: WrittenIdentity = {
      subject: headers['x-shuttle-user'] ?? '',
      email: headers['x-shuttle-email'],
      roles: (headers['x-shuttle-roles'] ?? '').split(',').filter((role) => role.length > 0),
      workspaceId: headers['x-shuttle-workspace'],
    }
    // The key of the deployment is the key of the other harness: the
    // signature of the process is signed with another key, and the
    // verification refuses it.
    const verified = await verifyIdentity(
      identity,
      { method: 'GET', path, query, host: headers['x-forwarded-host'] ?? '' },
      verificationKeyOf(asymmetricIdentityKey(PRIVATE_KEY)),
      headers['x-shuttle-signature']
    )
    expect(verified).toBe(false)
  })
})
