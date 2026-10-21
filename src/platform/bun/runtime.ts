/**
 * The version of the runtime of the process.
 *
 * The api of the runtime belongs to the platform: the version is read here
 * and the policy that decides whether it is good enough lives in the
 * runtime.
 */

/** The version of the runtime of the process, as the runtime reports it. */
export function runtimeVersion(): string {
  return Bun.version
}
