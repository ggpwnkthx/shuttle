import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { checkVersionConsistency, checkVersions } from '../../scripts/version'

const root = resolve(import.meta.dir, '..', '..')

describe('the version of the release', () => {
  test('it is the same in every file that holds it', async () => {
    expect(await checkVersions(root)).toEqual([])
  })

  test('a file that holds another version is reported', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      Dockerfile: 'ARG VERSION=1.2.3\n',
      'deploy/kubernetes/deployment.yaml': 'image: ghcr.io/ggpwnkthx/shuttle:0.1.0\n',
    })
    expect(findings).toEqual([
      {
        file: 'deploy/kubernetes/deployment.yaml',
        message: 'the version is "0.1.0" and the package says "1.2.3"',
      },
    ])
  })

  test('a file that holds no version at all is reported', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      Dockerfile: 'ARG REVISION=unknown\n',
    })
    expect(findings).toEqual([
      { file: 'Dockerfile', message: 'the version 1.2.3 could not be found' },
    ])
  })

  test('a package without a version is reported', () => {
    const findings = checkVersionConsistency({ 'package.json': JSON.stringify({}) })
    expect(findings).toEqual([
      { file: 'package.json', message: 'the package does not hold a version' },
    ])
  })
})
