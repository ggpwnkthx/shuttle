#!/usr/bin/env bun
/**
 * The version of the release is written in several places: the package, the
 * image, the manifests of the deployment, the changelog and the status of
 * the specification. They have to name the same release, because a
 * manifest that points at an image of another version deploys something
 * else than the one that was released, and a specification that carries
 * the status of another release describes a contract that was not
 * shipped.
 *
 * This script checks that they agree. It runs in the test suite and in the
 * CI workflow, so a drift fails the build instead of shipping.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A disagreement between two files about the version of the release. */
export interface VersionFinding {
  /** The file the disagreement was found in. */
  file: string
  /** What the file says and what it should say. */
  message: string
}

/** The files that hold the version of the release, and how to read it. */
export const VERSION_SOURCES: ReadonlyArray<{
  path: string
  /** Reads the version out of the content of the file, or null when it holds none. */
  read: (content: string) => string | null
}> = [
  {
    path: 'package.json',
    read: (content) => {
      try {
        const parsed = JSON.parse(content) as { version?: unknown }
        return typeof parsed.version === 'string' ? parsed.version : null
      } catch {
        return null
      }
    },
  },
  {
    path: 'Dockerfile',
    read: (content) => /^ARG VERSION=(.+)$/m.exec(content)?.[1]?.trim() ?? null,
  },
  {
    path: 'deploy/kubernetes/deployment.yaml',
    read: (content) =>
      /image:\s*ghcr\.io\/ggpwnkthx\/shuttle:(.+)$/m.exec(content)?.[1]?.trim() ?? null,
  },
  {
    path: 'deploy/kubernetes/kustomization.yaml',
    read: (content) => /newTag:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? null,
  },
  {
    path: 'deploy/compose.production.yaml',
    read: (content) =>
      /image:\s*ghcr\.io\/ggpwnkthx\/shuttle:(.+)$/m.exec(content)?.[1]?.trim() ?? null,
  },
  {
    path: 'src/runtime/version.ts',
    read: (content) => /export const VERSION = '(.+)'/.exec(content)?.[1]?.trim() ?? null,
  },
  {
    path: 'CHANGELOG.md',
    // The latest release of the changelog: the first heading of a version.
    read: (content) => /^##\s+(\d+\.\d+\.\d+)/m.exec(content)?.[1] ?? null,
  },
  {
    path: 'docs/spec.md',
    // The status of the specification: the release it describes.
    read: (content) => /^Status:\s*(\d+\.\d+\.\d+)/m.exec(content)?.[1] ?? null,
  },
]

/**
 * Checks that the files hold the same version.
 *
 * The version of the package is the reference: it is the one the release
 * workflow reads and the one the tag of the release carries.
 */
export function checkVersionConsistency(files: Record<string, string>): VersionFinding[] {
  const findings: VersionFinding[] = []
  const reference = files['package.json'] ? VERSION_SOURCES[0]!.read(files['package.json']) : null
  if (!reference) {
    findings.push({ file: 'package.json', message: 'the package does not hold a version' })
    return findings
  }
  for (const source of VERSION_SOURCES) {
    const content = files[source.path]
    if (content === undefined) continue
    const version = source.read(content)
    if (version === null) {
      findings.push({ file: source.path, message: `the version ${reference} could not be found` })
      continue
    }
    if (version !== reference) {
      findings.push({
        file: source.path,
        message: `the version is "${version}" and the package says "${reference}"`,
      })
    }
  }
  return findings
}

/** Reads the files of the tree and checks that they agree. */
export async function checkVersions(root: string): Promise<VersionFinding[]> {
  const files: Record<string, string> = {}
  for (const source of VERSION_SOURCES) {
    try {
      files[source.path] = await readFile(join(root, source.path), 'utf8')
    } catch {
      // A file that is not there is not a disagreement: it is reported by
      // the check of the files that are.
    }
  }
  return checkVersionConsistency(files)
}

if (import.meta.main) {
  const root = process.cwd()
  const findings = await checkVersions(root)
  if (findings.length === 0) {
    console.log('the version of the release is the same everywhere')
    process.exit(0)
  }
  for (const finding of findings) {
    console.error(`${finding.file}: ${finding.message}`)
  }
  console.error('the version of the release is not the same everywhere')
  process.exit(1)
}
