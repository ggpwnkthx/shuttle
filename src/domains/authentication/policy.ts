/**
 * The authentication policy of a route.
 *
 * The policy says which credentials a route accepts and whether the access
 * service has to be asked about the workspace of the request. The schema is
 * strict: an unknown key is a configuration error and not a setting that is
 * silently ignored.
 *
 * A policy that the gateway does not implement has to be refused loudly: a
 * setting that looks active but is not is a security hole.
 */

import { z } from 'zod'

/**
 * The modes of the authentication.
 *
 * - `none`    the request is forwarded unauthenticated
 * - `session` the session cookie of the gateway
 * - `jwt`     the bearer token of the caller
 * - `any`     the bearer token first, the session cookie second
 */
export const AuthModeSchema = z.enum(['none', 'session', 'jwt', 'any'])
export type AuthMode = z.infer<typeof AuthModeSchema>

/**
 * The workspace check of a route.
 *
 * The parameter is the name of the placeholder of the path that carries the
 * identifier of the workspace. The configuration domain checks that the
 * placeholder exists in the path of the route: the policy does not know the
 * path.
 */
export const WorkspacePolicySchema = z.strictObject({
  /** The name of the placeholder that carries the workspace identifier. */
  param: z.string().min(1).max(64),
  /** Refuse a workspace identifier that is not a UUID. */
  requireUuid: z.boolean().default(true),
})

/**
 * The authentication policy of a route.
 *
 * A workspace check needs an authentication mode: the gateway asks the
 * access service about a caller it authenticated, so a policy without a
 * credential could never be satisfied.
 */
export const AuthPolicySchema = z
  .strictObject({
    mode: AuthModeSchema.default('none'),
    workspace: WorkspacePolicySchema.optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.mode === 'none' && policy.workspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: 'a workspace check needs an authentication mode other than "none"',
      })
    }
  })
export type AuthPolicy = z.infer<typeof AuthPolicySchema>
