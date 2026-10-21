/**
 * The conformance of the access service.
 *
 * The suite runs against the reference implementation of `services/`, and
 * against the service of a deployment when `SHUTTLE_TEST_ACCESS_URL` names
 * one: a deployment that writes its own access service runs the same
 * checks against it, so the gateway can be pointed at it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { startAccessService } from '../../services/access-service'
import { describeAccessService } from './access-conformance'

/** The workspace of the suite. */
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

/** The policy of the reference implementation. */
const POLICY = {
  version: 1,
  subjects: {
    'alice@example.com': { workspaces: [WORKSPACE], roles: ['editor'] },
    'bob@example.com': { workspaces: [WORKSPACE] },
    // A subject of a deployment that has no workspaces: it may use one
    // route and no other.
    'carol@example.com': { workspaces: [], routes: ['admin-api'] },
  },
}

describe('the reference access service', () => {
  test('the service starts and answers', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/healthz`)
      expect(response.status).toBe(200)
    } finally {
      await service.stop()
    }
  })

  test('a subject that may use the workspace is allowed', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'alice@example.com',
          workspaceId: WORKSPACE,
          routeId: 'workspace-api',
          roles: ['editor'],
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ allow: true })
    } finally {
      await service.stop()
    }
  })

  test('a subject without the role is denied', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'alice@example.com',
          workspaceId: WORKSPACE,
          routeId: 'workspace-api',
          roles: [],
        }),
      })
      const body = (await response.json()) as { allow: boolean; reason: string }
      expect(body.allow).toBe(false)
      expect(body.reason).toContain('role')
    } finally {
      await service.stop()
    }
  })

  test('a subject that is not known is denied', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'mallory@example.com',
          workspaceId: WORKSPACE,
          routeId: 'workspace-api',
          roles: [],
        }),
      })
      const body = (await response.json()) as { allow: boolean }
      expect(body.allow).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('a subject that may use a route that names no workspace is allowed', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'carol@example.com',
          routeId: 'admin-api',
          roles: [],
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ allow: true })
    } finally {
      await service.stop()
    }
  })

  test('a subject that may not use a route that names no workspace is denied', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0 })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'carol@example.com',
          routeId: 'another-route',
          roles: [],
        }),
      })
      const body = (await response.json()) as { allow: boolean; reason: string }
      expect(body.allow).toBe(false)
      expect(body.reason).toContain('route')
    } finally {
      await service.stop()
    }
  })

  test('a call without the token is refused', async () => {
    const service = await startAccessService({ policy: POLICY, port: 0, token: 'secret' })
    try {
      const response = await fetch(`${service.url}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'alice@example.com',
          workspaceId: WORKSPACE,
          routeId: 'workspace-api',
          roles: ['editor'],
        }),
      })
      expect(response.status).toBe(401)
    } finally {
      await service.stop()
    }
  })
})

/**
 * The reference implementation, running for the suite.
 *
 * The suite is the protocol of the service and the reference implementation
 * is the service that speaks it: the two are checked against each other
 * here, once, so the protocol and its reference do not drift apart.
 */
const reference = await startAccessService({ policy: POLICY, port: 0, token: 'conformance-token' })
afterAll(async () => {
  await reference.stop()
})

describeAccessService('the reference implementation', {
  baseUrl: reference.url,
  token: 'conformance-token',
  allowed: { subject: 'alice@example.com', workspaceId: WORKSPACE, roles: ['editor'] },
  denied: { subject: 'mallory@example.com', workspaceId: WORKSPACE },
  allowedWithoutWorkspace: { subject: 'carol@example.com', routeId: 'admin-api' },
})

/**
 * The suite against the service of a deployment.
 *
 * The suite is skipped when the deployment does not name one: the service
 * is not part of Shuttle and a developer without one still runs the rest
 * of the tests.
 */
const externalUrl = process.env.SHUTTLE_TEST_ACCESS_URL
if (externalUrl) {
  describeAccessService('the service of the deployment', {
    baseUrl: externalUrl,
    token: process.env.SHUTTLE_TEST_ACCESS_TOKEN,
    allowed: {
      subject: process.env.SHUTTLE_TEST_ACCESS_ALLOWED_SUBJECT ?? 'alice@example.com',
      workspaceId:
        process.env.SHUTTLE_TEST_ACCESS_ALLOWED_WORKSPACE ?? '11111111-1111-4111-8111-111111111111',
      roles: process.env.SHUTTLE_TEST_ACCESS_ALLOWED_ROLES?.split(',').filter(Boolean),
    },
    denied: {
      subject: process.env.SHUTTLE_TEST_ACCESS_DENIED_SUBJECT ?? 'mallory@example.com',
      workspaceId:
        process.env.SHUTTLE_TEST_ACCESS_DENIED_WORKSPACE ?? '22222222-2222-4222-8222-222222222222',
    },
  })
}
