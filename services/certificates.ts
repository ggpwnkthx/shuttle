#!/usr/bin/env bun
/**
 * The certificates of the tests of the TLS.
 *
 * The tests of the connections to the upstreams need a certificate of a
 * server, a certificate of a client and the authority that signs them. They
 * are generated when the tests run: a certificate in the repository is a
 * secret that outlives the test that needs it.
 *
 * The generation uses the `openssl` of the machine. It is a tool of the
 * build environment, not a dependency of the gateway.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The certificates of a test of the TLS. */
export interface TestCertificates {
  /** The authority that signs the certificates, in PEM. */
  ca: string
  /** The certificate of the server, in PEM. */
  serverCert: string
  /** The private key of the server, in PEM. */
  serverKey: string
  /** The certificate of the client, in PEM. */
  clientCert: string
  /** The private key of the client, in PEM. */
  clientKey: string
  /** Removes the files of the certificates. */
  cleanup: () => Promise<void>
}

/** Runs a command of the build environment and fails when it fails. */
async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const code = await process.exited
  if (code !== 0) {
    const errors = await new Response(process.stderr).text()
    throw new Error(`${command} ${args.join(' ')} failed with the code ${code}: ${errors}`)
  }
}

/**
 * Generates the certificates of a test of the TLS.
 *
 * The authority signs a certificate of a server for `127.0.0.1` and a
 * certificate of a client. The keys are elliptic: they are generated in
 * milliseconds and they are enough for a test.
 */
export async function createTestCertificates(): Promise<TestCertificates> {
  const directory = await mkdtemp(join(tmpdir(), 'shuttle-certificates-'))
  const path = (name: string): string => join(directory, name)

  // A key of the curve P-256.
  const key = async (name: string): Promise<void> => {
    await run('openssl', [
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-out',
      path(name),
    ])
  }

  // The authority.
  await key('ca.key')
  await run('openssl', [
    'req',
    '-x509',
    '-key',
    path('ca.key'),
    '-out',
    path('ca.pem'),
    '-days',
    '2',
    '-subj',
    '/CN=shuttle-test-ca',
  ])

  // The certificate of the server: it is the one the upstream presents.
  await key('server.key')
  await run('openssl', [
    'req',
    '-new',
    '-key',
    path('server.key'),
    '-out',
    path('server.csr'),
    '-subj',
    '/CN=127.0.0.1',
  ])
  await writeFile(
    path('server.ext'),
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n'
  )
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    path('server.csr'),
    '-CA',
    path('ca.pem'),
    '-CAkey',
    path('ca.key'),
    '-CAcreateserial',
    '-out',
    path('server.pem'),
    '-days',
    '2',
    '-extfile',
    path('server.ext'),
  ])

  // The certificate of the client: it is the one the gateway presents.
  await key('client.key')
  await run('openssl', [
    'req',
    '-new',
    '-key',
    path('client.key'),
    '-out',
    path('client.csr'),
    '-subj',
    '/CN=shuttle-client',
  ])
  await writeFile(path('client.ext'), 'extendedKeyUsage=clientAuth\n')
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    path('client.csr'),
    '-CA',
    path('ca.pem'),
    '-CAkey',
    path('ca.key'),
    '-CAcreateserial',
    '-out',
    path('client.pem'),
    '-days',
    '2',
    '-extfile',
    path('client.ext'),
  ])

  const read = async (name: string): Promise<string> => await readFile(path(name), 'utf8')
  return {
    ca: await read('ca.pem'),
    serverCert: await read('server.pem'),
    serverKey: await read('server.key'),
    clientCert: await read('client.pem'),
    clientKey: await read('client.key'),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
