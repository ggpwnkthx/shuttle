#!/usr/bin/env bun
/**
 * The consistency of the environment and of its documentation.
 *
 * The names of the variables of the gateway live in `src/runtime/env.ts`
 * and nowhere else. The `.env.example` and the operations manual describe
 * them for the operator, and a variable that is not described is a
 * variable nobody sets, and a variable that is described and does not
 * exist is a setting that looks active but is not.
 *
 * The check finds the drift in both directions and it fails the build
 * instead of being noticed in a review: the documentation of the release
 * 0.4.0 had drifted from the code in several places, and the fix was
 * always manual.
 *
 * It runs in the test suite (`test/architecture/environment.test.ts`) and
 * in the CI workflow.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The file that holds the names of the variables. */
export const SOURCE = 'src/runtime/env.ts'

/** The file that holds the full list of the variables and their defaults. */
export const EXAMPLE = '.env.example'

/** The file that holds the manual of the deployment. */
export const MANUAL = 'docs/operations.md'

/**
 * The prefix of the variables of the test suite.
 *
 * They are read by the tests and not by the gateway: the manual of the
 * deployment describes them, and they are not a drift.
 */
export const TEST_PREFIX = 'SHUTTLE_TEST_'

/** A disagreement between the code and its documentation. */
export interface EnvironmentFinding {
  /** The file the disagreement was found in. */
  file: string
  /** The name of the variable. */
  variable: string
  /** What is wrong. */
  message: string
}

/**
 * The names of the variables the gateway reads.
 *
 * They are the keys of the schema of the environment: the module is the
 * only place that reads `process.env`, so the names are the keys of the
 * schema and nothing else.
 */
export function variablesOf(source: string): string[] {
  const names = new Set<string>()
  const pattern = /^\s*(SHUTTLE_[A-Z0-9_]+)\s*:/gm
  for (const match of source.matchAll(pattern)) {
    names.add(match[1]!)
  }
  return [...names].sort()
}

/**
 * The names of the variables the gateway refuses to start without.
 *
 * They are the variables the production validation of the environment
 * names in the message it throws: a production deployment has to set
 * them, so the manual of the deployment has to describe them.
 */
export function requiredVariables(source: string): string[] {
  const names = new Set<string>()
  const pattern = /'(SHUTTLE_[A-Z0-9_]+) must be set/g
  for (const match of source.matchAll(pattern)) {
    names.add(match[1]!)
  }
  return [...names].sort()
}

/**
 * The names of the variables a document mentions.
 *
 * A name is mentioned when it appears in the document, whether it is set
 * or commented out: the `.env.example` lists the variables that are set
 * and the ones that are commented out with their default.
 */
export function mentionedVariables(document: string): string[] {
  const names = new Set<string>()
  const pattern = /\b(SHUTTLE_[A-Z0-9_]+)\b/g
  for (const match of document.matchAll(pattern)) {
    names.add(match[1]!)
  }
  return [...names].sort()
}

/**
 * Checks that the code and its documentation agree.
 *
 * The result is the list of the disagreements: an empty list means that
 * every variable of the code is described and that every variable of the
 * documentation exists.
 */
export function checkEnvironment(files: Record<string, string>): EnvironmentFinding[] {
  const findings: EnvironmentFinding[] = []
  const source = files[SOURCE]
  if (source === undefined) {
    return [
      { file: SOURCE, variable: '', message: 'the file that holds the environment is missing' },
    ]
  }
  const declared = variablesOf(source)
  const required = requiredVariables(source)

  // The example holds the full list: every variable of the gateway is in
  // it, with its default.
  const example = files[EXAMPLE]
  if (example !== undefined) {
    const mentioned = new Set(mentionedVariables(example))
    for (const variable of declared) {
      if (!mentioned.has(variable)) {
        findings.push({
          file: EXAMPLE,
          variable,
          message: `the variable "${variable}" is not in the example`,
        })
      }
    }
    for (const variable of mentioned) {
      if (variable.startsWith(TEST_PREFIX)) continue
      if (!declared.includes(variable)) {
        findings.push({
          file: EXAMPLE,
          variable,
          message: `the variable "${variable}" is in the example and the gateway does not read it`,
        })
      }
    }
  }

  // The manual holds the variables a production deployment has to set: the
  // ones the gateway refuses to start without.
  const manual = files[MANUAL]
  if (manual !== undefined) {
    const mentioned = new Set(mentionedVariables(manual))
    for (const variable of required) {
      if (!mentioned.has(variable)) {
        findings.push({
          file: MANUAL,
          variable,
          message: `the variable "${variable}" is required in production and the manual does not describe it`,
        })
      }
    }
    for (const variable of mentioned) {
      if (variable.startsWith(TEST_PREFIX)) continue
      if (!declared.includes(variable)) {
        findings.push({
          file: MANUAL,
          variable,
          message: `the variable "${variable}" is described and the gateway does not read it`,
        })
      }
    }
  }
  return findings
}

/** Reads the files of the tree and checks that they agree. */
export async function checkEnvironmentOf(root: string): Promise<EnvironmentFinding[]> {
  const files: Record<string, string> = {}
  for (const path of [SOURCE, EXAMPLE, MANUAL]) {
    try {
      files[path] = await readFile(join(root, path), 'utf8')
    } catch {
      // A file that is not there is not a disagreement: it is reported by
      // the check of the files that are.
    }
  }
  return checkEnvironment(files)
}

if (import.meta.main) {
  const root = process.cwd()
  const findings = await checkEnvironmentOf(root)
  if (findings.length === 0) {
    console.log('every variable of the environment is described')
    process.exit(0)
  }
  for (const finding of findings) {
    console.error(`${finding.file}: ${finding.message}`)
  }
  console.error('the documentation of the environment does not agree with the code')
  process.exit(1)
}
