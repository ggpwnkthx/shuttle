import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  EXAMPLE,
  MANUAL,
  SOURCE,
  checkEnvironment,
  mentionedVariables,
  requiredVariables,
  variablesOf,
} from '../../scripts/environment'

/**
 * The consistency of the environment and of its documentation.
 *
 * The names of the variables live in `src/runtime/env.ts` and nowhere
 * else. The example holds the full list and the manual holds the
 * variables a production deployment has to set. A variable that is not
 * described is a variable nobody sets, and a variable that is described
 * and does not exist is a setting that looks active but is not.
 */
const root = join(import.meta.dir, '..', '..')

describe('the environment of the gateway', () => {
  test('every variable of the code is in the example and the manual describes the ones that are required', async () => {
    const files: Record<string, string> = {}
    for (const path of [SOURCE, EXAMPLE, MANUAL]) {
      files[path] = await Bun.file(join(root, path)).text()
    }
    expect(checkEnvironment(files)).toEqual([])
  })

  test('the names of the variables are the keys of the schema', () => {
    const source = `
      const EnvSchema = z.object({
        SHUTTLE_CONFIG: z.string().default('./config/routes.json'),
        SHUTTLE_GATEWAY_PORT: intEnv(8080),
      })
    `
    expect(variablesOf(source)).toEqual(['SHUTTLE_CONFIG', 'SHUTTLE_GATEWAY_PORT'])
  })

  test('the variables that are required in production are the ones the validation names', () => {
    const source = `
      throw new Error('SHUTTLE_SESSION_SECRET must be set in a production environment')
      throw new Error('SHUTTLE_OIDC_ISSUER must be set in a production environment')
    `
    expect(requiredVariables(source)).toEqual(['SHUTTLE_OIDC_ISSUER', 'SHUTTLE_SESSION_SECRET'])
  })

  test('the names a document mentions are found', () => {
    expect(
      mentionedVariables('SHUTTLE_CONFIG=/etc/shuttle/routes.json\n# SHUTTLE_PORT=8080')
    ).toEqual(['SHUTTLE_CONFIG', 'SHUTTLE_PORT'])
  })

  test('a variable that is not described is reported', () => {
    const findings = checkEnvironment({
      [SOURCE]: 'const EnvSchema = z.object({\n  SHUTTLE_ONE: z.string(),\n})',
      [EXAMPLE]: 'SHUTTLE_TWO=2',
      [MANUAL]: '',
    })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some((finding) => finding.variable === 'SHUTTLE_ONE')).toBe(true)
    expect(findings.some((finding) => finding.variable === 'SHUTTLE_TWO')).toBe(true)
  })

  test('the files of the check are the ones of the project', () => {
    expect(SOURCE).toBe('src/runtime/env.ts')
    expect(EXAMPLE).toBe('.env.example')
    expect(MANUAL).toBe('docs/operations.md')
  })
})
