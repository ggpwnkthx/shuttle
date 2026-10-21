/**
 * The backends of the shared state.
 *
 * The state that the replicas share — the sessions, the rate limits and
 * the cached decisions — lives in one of two servers:
 *
 * - a **Redis** server, reached with `redis://` or `rediss://`;
 * - a **Postgres** server, reached with `postgres://` or `postgresql://`.
 *
 * The scheme of the url picks the backend, so the infrastructure only has
 * to provide a single value and a deployment can measure the two side by
 * side (see `docs/capacity.md`).
 *
 * The module is in the runtime layer because it is the runtime that
 * assembles the two backends; the platforms know nothing of each other.
 */

import { isRedisUrl } from '../platform/redis'
import { isPostgresUrl } from '../platform/postgres'

/** The backends the shared state may live in. */
export type SharedStateBackend = 'redis' | 'postgres'

/**
 * The backend an url names, or undefined when it names none.
 *
 * An url that names no backend is either the memory of the process
 * (`memory://local`) or a mistake: the environment refuses the second one
 * in a production deployment.
 */
export function sharedStateBackend(url: string | undefined | null): SharedStateBackend | undefined {
  if (isRedisUrl(url)) return 'redis'
  if (isPostgresUrl(url)) return 'postgres'
  return undefined
}

/**
 * Reports whether an url names a server whose state is shared by the
 * replicas.
 *
 * A state that lives in the memory of one replica is unknown to the others,
 * so a production deployment has to name a server.
 */
export function isSharedStateUrl(url: string | undefined | null): boolean {
  return sharedStateBackend(url) !== undefined
}
