import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { FIRST_TEST_PORT, freePort, TEST_PORT_COUNT } from './port'

/**
 * The ports of the tests.
 *
 * The kernel picks the ports of the sockets that bind to the port zero in
 * the range of the ephemeral ports. A port of the tests that comes from
 * that range can be handed out again to a fixture that starts after the
 * port was reserved and released, and the gateway then fails to bind it.
 */
describe('the ports of the tests', () => {
  test('the port comes from the range of the tests, not from the ephemeral range', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThanOrEqual(FIRST_TEST_PORT)
    expect(port).toBeLessThan(FIRST_TEST_PORT + TEST_PORT_COUNT)
    // The range of the ephemeral ports of the kernel: a port of the
    // tests is never one of them.
    expect(port).toBeLessThan(32768)
  })

  test('the port is free when it is returned', async () => {
    const port = await freePort()
    // The port can be bound: it was free a moment ago and nothing else
    // took it.
    const bound = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true))
      })
    })
    expect(bound).toBe(true)
  })
})
