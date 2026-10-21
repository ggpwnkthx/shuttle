/**
 * The ports of the tests and of the fixtures.
 *
 * The kernel picks the port of a socket that binds to the port zero, and
 * it picks it in the range of the ephemeral ports (32768 to 60999 on a
 * default installation). A port that is **reserved by a probe and
 * released** before the server that needs it binds it is a port the
 * kernel may hand out again in the meantime: the server then fails to
 * bind it, and the failure says nothing about the reason.
 *
 * The ports of the tests and of the fixtures are therefore drawn from a
 * range the kernel never uses for the ephemeral ports. A port of the
 * tests and a port of a fixture cannot be the same number, and the
 * servers that bind the port zero keep the atomicity of their own
 * allocation.
 */

import { createServer } from 'node:net'

/** The first port of the range of the tests. */
export const FIRST_TEST_PORT = 20000

/** The number of ports of the range of the tests. */
export const TEST_PORT_COUNT = 10000

/**
 * Finds a free port of the range of the tests.
 *
 * The port is bound and released to prove that it is free. A port that is
 * taken is refused and another one is drawn.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = FIRST_TEST_PORT + Math.floor(Math.random() * TEST_PORT_COUNT)
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => {
        const address = probe.address()
        const bound = typeof address === 'object' && address !== null && address.port === port
        probe.close(() => resolve(bound))
      })
    })
    if (free) return port
  }
  throw new Error('the tests could not find a free port')
}
