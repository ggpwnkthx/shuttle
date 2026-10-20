import { describe, expect, test } from 'bun:test'
import { AccessClient } from '../../src/domains/workspace-access'
import { MemoryDecisionCache } from '../../src/domains/workspace-access/adapters'
import { FetchAccessTransport } from '../../src/platform/bun/access-transport'
import { startAccessService } from '../../services/access-fixture'

/**
 * The client of the access service, against the real fixture.
 *
 * The contract of the domain is about the failures: a service that is not
 * there, a service that answers with something else than a decision and a
 * decision that is not for this caller.
 */
describe('the access service', () => {
  test('a decision of the service allows the caller', async () => {
    const service = await startAccessService()
    const client = new AccessClient({
      baseUrl: service.url,
      transport: new FetchAccessTransport(),
      cache: new MemoryDecisionCache(),
      cacheTtlMs: 0,
    })
    const decision = await client.decide({
      subject: 'user-alice',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
      roles: ['admin'],
    })
    expect(decision.allow).toBe(true)
    // The service received exactly the values the specification names.
    expect(service.requests[0]).toEqual({
      subject: 'user-alice',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
      roles: ['admin'],
    })
    await service.stop()
  })

  test('a subject that does not exist is denied', async () => {
    const service = await startAccessService()
    const client = new AccessClient({
      baseUrl: service.url,
      transport: new FetchAccessTransport(),
      cache: new MemoryDecisionCache(),
      cacheTtlMs: 0,
    })
    const decision = await client.decide({
      subject: 'user-nobody',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(decision.allow).toBe(false)
    await service.stop()
  })

  test('a service that is not there denies the caller', async () => {
    const client = new AccessClient({
      baseUrl: 'http://127.0.0.1:1',
      transport: new FetchAccessTransport(),
      cache: new MemoryDecisionCache(),
      cacheTtlMs: 0,
    })
    const decision = await client.decide({
      subject: 'user-alice',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(decision.allow).toBe(false)
  })

  test('a service that answers with an error denies the caller', async () => {
    const service = await startAccessService({ unavailable: true })
    const client = new AccessClient({
      baseUrl: service.url,
      transport: new FetchAccessTransport(),
      cache: new MemoryDecisionCache(),
      cacheTtlMs: 0,
    })
    const decision = await client.decide({
      subject: 'user-alice',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(decision.allow).toBe(false)
    await service.stop()
  })
})
