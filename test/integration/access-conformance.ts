/**
 * The protocol of the access service, as a suite of checks.
 *
 * The gateway asks an access service that it does not own: the service is
 * a dependency of the deployment, and the deployment may write its own.
 * The suite here is the contract of that dependency: an implementation
 * that passes it speaks the protocol of §6 of the specification, and the
 * gateway can be pointed at it.
 *
 * The suite is parameterized by the expectations of the implementation: it
 * cannot know which subjects a service knows. A deployment that writes its
 * own service runs the suite against it with a profile that names one
 * subject that may use one workspace and one that may not.
 *
 * ```bash
 * SHUTTLE_TEST_ACCESS_URL=http://127.0.0.1:8090 \
 * SHUTTLE_TEST_ACCESS_TOKEN=… \
 * SHUTTLE_TEST_ACCESS_ALLOWED_SUBJECT=alice@example.com \
 * SHUTTLE_TEST_ACCESS_ALLOWED_WORKSPACE=11111111-1111-4111-8111-111111111111 \
 * bun test test/integration/access-conformance.test.ts
 * ```
 */

import { describe, expect, test } from 'bun:test'

/** The expectations of the suite about an implementation. */
export interface AccessConformanceProfile {
  /** The base url of the service. */
  baseUrl: string
  /** The token the service expects, when it expects one. */
  token?: string
  /** A subject the service allows to use a workspace. */
  allowed: { subject: string; workspaceId: string; roles?: string[] }
  /** A subject the service denies. */
  denied: { subject: string; workspaceId: string; roles?: string[] }
  /**
   * A subject the service allows to use a route that names no workspace.
   *
   * When it is absent, the suite checks that a request that names no
   * workspace is answered with a decision, and not refused: the workspace
   * is optional in the protocol.
   */
  allowedWithoutWorkspace?: { subject: string; routeId: string; roles?: string[] }
}

/** Sends a decision request to the service. */
async function decide(
  profile: AccessConformanceProfile,
  body: Record<string, unknown>
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (profile.token) headers.authorization = `Bearer ${profile.token}`
  const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/v1/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json }
}

/**
 * Runs the suite against an implementation.
 *
 * The label names the implementation in the output of the tests.
 */
export function describeAccessService(label: string, profile: AccessConformanceProfile): void {
  describe(`the access service in ${label}`, () => {
    test('a subject that may use a workspace is allowed', async () => {
      const { status, json } = await decide(profile, {
        subject: profile.allowed.subject,
        workspaceId: profile.allowed.workspaceId,
        routeId: 'workspace-api',
        roles: profile.allowed.roles ?? [],
      })
      expect(status).toBe(200)
      expect(json).toBeObject()
      expect((json as { allow?: unknown }).allow).toBe(true)
    })

    test('a subject that may not use a workspace is denied', async () => {
      const { status, json } = await decide(profile, {
        subject: profile.denied.subject,
        workspaceId: profile.denied.workspaceId,
        routeId: 'workspace-api',
        roles: profile.denied.roles ?? [],
      })
      expect(status).toBe(200)
      expect(json).toBeObject()
      expect((json as { allow?: unknown }).allow).toBe(false)
    })

    test('a denial carries a reason', async () => {
      const { json } = await decide(profile, {
        subject: profile.denied.subject,
        workspaceId: profile.denied.workspaceId,
        routeId: 'workspace-api',
        roles: profile.denied.roles ?? [],
      })
      const reason = (json as { reason?: unknown }).reason
      expect(typeof reason).toBe('string')
      expect((reason as string).length).toBeGreaterThan(0)
    })

    test('a denial carries the code of its reason', async () => {
      // The gateway counts the **code** of the reason and never its text:
      // a service that rewords its reason must not change the metric of
      // the gateway. The code is optional in the protocol, and a service
      // that sends none is counted as `access_denied`.
      const { json } = await decide(profile, {
        subject: profile.denied.subject,
        workspaceId: profile.denied.workspaceId,
        routeId: 'workspace-api',
        roles: profile.denied.roles ?? [],
      })
      const code = (json as { reasonCode?: unknown }).reasonCode
      if (code === undefined) return
      expect(['missing_role', 'workspace_not_found', 'policy_denied', 'access_denied']).toContain(
        code as string
      )
    })

    test('a request without a subject is refused', async () => {
      const { status } = await decide(profile, { workspaceId: 'a-workspace' })
      expect(status).toBe(400)
    })

    test('a request without a workspace is answered', async () => {
      // The workspace is optional: a route that asks the access service
      // about itself names none, and the service decides on the subject,
      // the route and the roles.
      const { status, json } = await decide(profile, {
        subject: profile.allowed.subject,
        routeId: 'workspace-api',
        roles: profile.allowed.roles ?? [],
      })
      expect(status).toBe(200)
      expect(json).toBeObject()
      expect(typeof (json as { allow?: unknown }).allow).toBe('boolean')
    })

    test('a request without a workspace is decided by the service', async () => {
      if (!profile.allowedWithoutWorkspace) return
      const { status, json } = await decide(profile, {
        subject: profile.allowedWithoutWorkspace.subject,
        routeId: profile.allowedWithoutWorkspace.routeId,
        roles: profile.allowedWithoutWorkspace.roles ?? [],
      })
      expect(status).toBe(200)
      expect((json as { allow?: unknown }).allow).toBe(true)
    })

    test('a request with an empty workspace is refused', async () => {
      const { status } = await decide(profile, {
        subject: profile.allowed.subject,
        workspaceId: '',
      })
      expect(status).toBe(400)
    })

    test('a body that is not json is refused', async () => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (profile.token) headers.authorization = `Bearer ${profile.token}`
      const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/v1/decisions`, {
        method: 'POST',
        headers,
        body: 'not json',
      })
      expect(response.status).toBe(400)
    })

    test('a call without the token is refused', async () => {
      if (!profile.token) return
      const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: profile.allowed.subject,
          workspaceId: profile.allowed.workspaceId,
          routeId: 'workspace-api',
          roles: [],
        }),
      })
      expect(response.status).toBe(401)
    })

    test('a call with a wrong token is refused', async () => {
      if (!profile.token) return
      const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/v1/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
        body: JSON.stringify({
          subject: profile.allowed.subject,
          workspaceId: profile.allowed.workspaceId,
          routeId: 'workspace-api',
          roles: [],
        }),
      })
      expect(response.status).toBe(401)
    })

    test('an unknown path is not found', async () => {
      const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/v1/something-else`)
      expect(response.status).toBe(404)
    })
  })
}
