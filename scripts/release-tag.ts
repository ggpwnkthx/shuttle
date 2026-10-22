#!/usr/bin/env bun
/**
 * The tag of a release.
 *
 * The version of a release lives in the package and in the files that
 * name it — `scripts/version.ts` checks that they agree — and the **tag**
 * is what turns a commit into a release: the workflow of the release and
 * the workflow of the binaries both run on a tag.
 *
 * This script decides whether a commit has to be tagged:
 *
 * - the version of the package is **greater** than the version of the
 *   latest tag → the tag of the version is created;
 * - the version of the package is the version of the latest tag → there
 *   is nothing to do;
 * - the version of the package is **older** than the version of the
 *   latest tag → the version was rolled back, and nothing is tagged.
 *
 * The tag is never moved: a tag that exists is a release that was
 * published, and a release that was published is not republished under
 * another name.
 *
 * The script runs the check of the versions before it decides: a tag of
 * a commit whose files do not agree on the version publishes a release
 * that describes another one.
 *
 *   bun run scripts/release-tag.ts            → what it would do
 *   bun run scripts/release-tag.ts --tag      → it does it
 */

import { checkVersions } from './version'

/** What the script does with the tag of the release. */
export type TagAction = 'create' | 'skip' | 'behind'

/** The decision of the script. */
export interface TagDecision {
  /** What is done with the tag. */
  action: TagAction
  /** The version of the package. */
  version: string
  /** The tag of the release. */
  tag: string
  /** The latest tag of the repository, when there is one. */
  latest?: string
  /** Why the decision is what it is. */
  reason: string
}

/**
 * The version of a tag.
 *
 * The tags of the repository are `v<version>`. A tag that does not name
 * a version — a tag of a person, a tag of a revision — is not one of
 * them, and it is ignored.
 */
export function versionOfTag(tag: string): string | undefined {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim())
  return match?.[1]
}

/**
 * Decides whether the tag of the version has to be created.
 *
 * The comparison is a comparison of versions and not a comparison of
 * strings: `0.10.0` is greater than `0.9.0`, and a string that says
 * otherwise is a bug that waits for the tenth release.
 */
export function decideTag(version: string, tags: readonly string[]): TagDecision {
  const tag = `v${version}`
  const versions = tags
    .map((candidate) => ({ tag: candidate, version: versionOfTag(candidate) }))
    .filter(
      (candidate): candidate is { tag: string; version: string } => candidate.version !== undefined
    )

  // The latest tag is the greatest version of them, not the last one in
  // the order of the repository.
  let latest: { tag: string; version: string } | undefined
  for (const candidate of versions) {
    if (!latest || Bun.semver.order(candidate.version, latest.version) > 0) latest = candidate
  }

  if (!latest) {
    return {
      action: 'create',
      version,
      tag,
      reason: 'the repository has no tag of a release yet',
    }
  }

  const order = Bun.semver.order(version, latest.version)
  if (order === 0) {
    return {
      action: 'skip',
      version,
      tag,
      latest: latest.tag,
      reason: `the tag of the release already exists: ${latest.tag}`,
    }
  }
  if (order < 0) {
    return {
      action: 'behind',
      version,
      tag,
      latest: latest.tag,
      reason: `the version of the package is older than the latest tag: ${latest.tag}`,
    }
  }
  return {
    action: 'create',
    version,
    tag,
    latest: latest.tag,
    reason: `the version of the package is greater than the latest tag: ${latest.tag}`,
  }
}

/** The tags of the repository, as the git sees them. */
export function tagsOf(root: string): string[] {
  const result = Bun.spawnSync(['git', 'tag', '--list', 'v*'], { cwd: root })
  if (result.exitCode !== 0) {
    throw new Error(`the tags of the repository could not be read: ${result.stderr.toString()}`)
  }
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The version of the package of the repository. */
export async function packageVersion(root: string): Promise<string> {
  const file = Bun.file(`${root}/package.json`)
  const parsed = JSON.parse(await file.text()) as { version?: unknown }
  if (typeof parsed.version !== 'string') {
    throw new Error('the package of the repository holds no version')
  }
  return parsed.version
}

if (import.meta.main) {
  const root = process.cwd()
  const write = process.argv.includes('--tag')

  // The files that name the version have to agree before a tag is pushed:
  // a release whose manifests name another version deploys something else
  // than the one that was released.
  const findings = await checkVersions(root)
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.message}`)
    }
    console.error('the version of the release is not the same everywhere: no tag is created')
    process.exit(1)
  }

  const version = await packageVersion(root)
  const decision = decideTag(version, tagsOf(root))

  /**
   * Writes what the script did.
   *
   * The two lines are the ones a workflow reads: `created` says whether
   * there is a release to start, and `tag` names it. The workflow writes
   * them in the output of its step, the way the other workflows of the
   * repository do.
   */
  const report = (created: boolean): void => {
    console.log(`created=${created}`)
    console.log(`tag=${decision.tag}`)
  }

  if (decision.action !== 'create') {
    console.log(`${decision.reason}: the tag ${decision.tag} is not created`)
    report(false)
    process.exit(0)
  }

  if (!write) {
    console.log(`${decision.reason}: the tag ${decision.tag} would be created`)
    report(false)
    process.exit(0)
  }

  // The tag is created on the commit that is checked out, and it is pushed
  // without force: a tag that exists is a release that was published.
  const created = Bun.spawnSync(['git', 'tag', decision.tag], { cwd: root })
  if (created.exitCode !== 0) {
    console.error(`the tag ${decision.tag} could not be created: ${created.stderr.toString()}`)
    process.exit(1)
  }
  const pushed = Bun.spawnSync(['git', 'push', 'origin', decision.tag], { cwd: root })
  if (pushed.exitCode !== 0) {
    console.error(`the tag ${decision.tag} could not be pushed: ${pushed.stderr.toString()}`)
    process.exit(1)
  }
  console.log(`the tag ${decision.tag} is pushed: the release of the version ${version} starts`)
  report(true)
}
