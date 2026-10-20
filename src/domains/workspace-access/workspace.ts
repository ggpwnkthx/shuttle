/**
 * The workspace of a request.
 *
 * The workspace is the unit of access control of the platform: the gateway
 * asks the access service whether a caller may use it. The gateway never
 * decides access on its own.
 */

/**
 * Reports whether a value is a UUID.
 *
 * The format is the one of the RFC 4122: eight groups of hexadecimal
 * digits separated by dashes. The version and the variant are not checked:
 * the access service is the one that decides what a workspace is.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** The reason a workspace was refused. */
export type WorkspaceRefusal = 'missing' | 'not_a_uuid'

/**
 * Validates the identifier of a workspace.
 *
 * The identifier is read from the path of the request, so a request that
 * does not carry it is a bad request: the route does not describe it.
 */
export function validateWorkspace(
  value: string | undefined,
  options: { requireUuid: boolean }
): { ok: true; workspaceId: string } | { ok: false; reason: WorkspaceRefusal } {
  if (value === undefined || value.length === 0) {
    return { ok: false, reason: 'missing' }
  }
  if (options.requireUuid && !isUuid(value)) {
    return { ok: false, reason: 'not_a_uuid' }
  }
  return { ok: true, workspaceId: value }
}
