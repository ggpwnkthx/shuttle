import { describe, expect, test } from 'bun:test'
import { decideTag, versionOfTag } from '../../scripts/release-tag'

/**
 * The tag of a release.
 *
 * The tag is what turns a commit into a release, and it is created when
 * the version of the package is greater than the version of the latest
 * tag. The comparison is a comparison of versions: `0.10.0` is greater
 * than `0.9.0`, and a string comparison gets it wrong.
 */
describe('the tag of a release', () => {
  test('a tag that names no version is not a tag of a release', () => {
    expect(versionOfTag('v1.0.0')).toBe('1.0.0')
    expect(versionOfTag('v1.0.0-rc.1')).toBe('1.0.0-rc.1')
    expect(versionOfTag('v1.0')).toBeUndefined()
    expect(versionOfTag('release-1.0.0')).toBeUndefined()
    expect(versionOfTag('vfoo')).toBeUndefined()
  })

  test('a repository without a tag gets one', () => {
    const decision = decideTag('1.0.0', [])
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v1.0.0')
  })

  test('a version that is greater than the latest tag is tagged', () => {
    const decision = decideTag('1.0.0', ['v0.5.0', 'v0.4.0'])
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v1.0.0')
    expect(decision.latest).toBe('v0.5.0')
  })

  test('the comparison is a comparison of versions and not of strings', () => {
    const decision = decideTag('0.10.0', ['v0.9.0'])
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v0.10.0')
  })

  test('the latest tag is the greatest one and not the last one', () => {
    const decision = decideTag('0.11.0', ['v0.9.0', 'v0.10.0'])
    expect(decision.action).toBe('create')
    expect(decision.latest).toBe('v0.10.0')
  })

  test('the version of the latest tag is not tagged again', () => {
    const decision = decideTag('1.0.0', ['v1.0.0', 'v0.5.0'])
    expect(decision.action).toBe('skip')
    expect(decision.tag).toBe('v1.0.0')
    expect(decision.latest).toBe('v1.0.0')
  })

  test('a version that is older than the latest tag is not tagged', () => {
    const decision = decideTag('0.9.0', ['v1.0.0'])
    expect(decision.action).toBe('behind')
    expect(decision.latest).toBe('v1.0.0')
  })

  test('a tag of a prerelease is a tag of a release', () => {
    const decision = decideTag('1.0.0-rc.1', ['v0.5.0'])
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v1.0.0-rc.1')
  })

  test('a prerelease is older than the release it leads to', () => {
    const decision = decideTag('1.0.0', ['v1.0.0-rc.1'])
    expect(decision.action).toBe('create')
    expect(decision.latest).toBe('v1.0.0-rc.1')
  })

  test('the tags that name no version are ignored', () => {
    const decision = decideTag('1.0.0', ['someone', 'v0.5.0'])
    expect(decision.action).toBe('create')
    expect(decision.latest).toBe('v0.5.0')
  })
})
