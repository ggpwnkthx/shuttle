#!/usr/bin/env bun
/**
 * The key that signs the identity of a request.
 *
 * The gateway signs the identity of every request it forwards, and the
 * upstreams verify it with the **public** key: an upstream that verifies
 * an identity cannot mint one.
 *
 * The script generates a pair and prints it:
 *
 *   bun run identity:key                 → a new pair
 *   bun run identity:key --public        → the public key of the key that
 *                                          is in SHUTTLE_IDENTITY_SIGNING_KEY
 *
 * The private key goes to the secret store of the deployment and to
 * `SHUTTLE_IDENTITY_SIGNING_KEY`; the public key goes to the upstreams. It
 * is the same on every replica: a signature that one replica signs and
 * another one does not is a signature the upstreams refuse.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'

/** The curve of the key: P-256, the curve of the `ES256` signature. */
const CURVE = 'prime256v1'

/** Generates a pair and prints it. */
function generate(): void {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  console.log('# The private key of the identity signature. It goes to the secret')
  console.log('# store of the deployment and to SHUTTLE_IDENTITY_SIGNING_KEY.')
  console.log(pem)
  console.log('# The public key of the identity signature. It goes to the upstreams,')
  console.log('# which verify the identity of a request with it.')
  console.log(publicPem)
}

/** Prints the public key of the key of the environment. */
function printPublicKey(): void {
  const pem = process.env.SHUTTLE_IDENTITY_SIGNING_KEY
  if (!pem) {
    console.error('SHUTTLE_IDENTITY_SIGNING_KEY is not set')
    process.exit(1)
  }
  try {
    const publicPem = createPublicKey(createPrivateKey(pem))
      .export({ type: 'spki', format: 'pem' })
      .toString()
    console.log(publicPem)
  } catch (error) {
    console.error(`the key of the environment is not a private key: ${String(error)}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  if (process.argv.includes('--public')) {
    printPublicKey()
  } else {
    generate()
  }
}
