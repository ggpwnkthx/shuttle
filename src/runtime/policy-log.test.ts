import { describe, expect, test } from 'bun:test'
import { ConfigurationStore } from '../domains/configuration'
import { createLogger } from '../observability'
import { logActiveConfiguration } from './policy-log'

/** A store with the defaults of the tests. */
function store(): ConfigurationStore {
  return new ConfigurationStore({
    source: '/etc/shuttle/routes.json',
    defaultMaxBodyBytes: 1_048_576,
  })
}

/** The lines the logger wrote. */
function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = []
  const logger = createLogger({ level: 'info', write: (line) => lines.push(line) })
  return { lines, logger }
}

describe('the log of the policy that is running', () => {
  test('every route of the configuration is written', () => {
    const configuration = store()
    configuration.apply({
      version: 1,
      defaults: { auth: { mode: 'none' } },
      routes: [
        {
          id: 'workspace-api',
          match: { host: 'api.example.com', path: '/ws/{workspaceId}/' },
          upstream: 'http://upstream-a:3000',
          auth: { mode: 'session', workspace: { param: 'workspaceId' } },
        },
      ],
    })
    const { lines, logger } = capture()
    logActiveConfiguration(logger, configuration.snapshot!)

    const route = lines.find((line) => line.includes('the route is active'))
    expect(route).toBeDefined()
    expect(route).toContain('"routeId":"workspace-api"')
    expect(route).toContain('"auth":"session"')
    expect(route).toContain('"workspace":"workspaceId"')
  })

  test('a permissive setting is written as a warning', () => {
    const configuration = store()
    configuration.apply({
      version: 1,
      defaults: { auth: { mode: 'none' } },
      routes: [
        { id: 'public', match: { host: '*', path: '/' }, upstream: 'http://upstream-a:3000' },
      ],
    })
    const { lines, logger } = capture()
    logActiveConfiguration(logger, configuration.snapshot!)

    const warning = lines.find((line) => line.includes('the setting is permissive'))
    expect(warning).toBeDefined()
    expect(warning).toContain('"code":"unauthenticated_route"')
    expect(warning).toContain('"level":"warn"')
  })

  test('the credentials of an upstream never reach the log', () => {
    const configuration = store()
    configuration.apply({
      version: 1,
      defaults: { auth: { mode: 'none' } },
      routes: [
        {
          id: 'private',
          match: { host: '*', path: '/' },
          upstream: 'http://user:secret@upstream-a:3000',
        },
      ],
    })
    const { lines, logger } = capture()
    logActiveConfiguration(logger, configuration.snapshot!)

    expect(lines.join('\n')).not.toContain('secret')
    expect(lines.join('\n')).toContain('upstream-a:3000')
  })
})
