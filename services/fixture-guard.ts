/**
 * Guard for the development fixtures.
 *
 * The services in this directory exist for the tests and for the local
 * development stack. They are not part of a deployment:
 *
 * - the identity provider fixture holds accounts with known passwords and
 *   signs tokens with a key it generates itself
 * - the access fixture makes authorization decisions with a static policy
 *
 * Both would be a security hole in a real environment, so they refuse to
 * start when the environment says it is a production one. The production
 * image does not contain this directory at all, the guard is the second line
 * of defence.
 */

export class FixtureInProductionError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'FixtureInProductionError'
    this.cause = cause
  }
}

/**
 * Throws when the fixtures are started in a production environment.
 *
 * `NODE_ENV=production` is the signal. `test` and `development` are allowed,
 * an unset `NODE_ENV` is allowed as well, so the fixtures work out of the box
 * in a development shell.
 */
export function assertFixtureAllowed(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  throw new FixtureInProductionError(
    `the ${name} is a development fixture and must not run with NODE_ENV=production`
  )
}
