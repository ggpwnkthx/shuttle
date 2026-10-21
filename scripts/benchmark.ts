#!/usr/bin/env bun
/**
 * The benchmark of the backends of the shared state.
 *
 * The gateway holds its shared state in a Redis server or in a Postgres
 * server. The two are interchangeable, and this script measures them side
 * by side: the same traffic, the same gateway, the only difference being
 * the server that holds the state.
 *
 * The scenarios are the paths of a request, and each of them pays a
 * different number of round trips to the shared state:
 *
 * | Scenario | What it pays |
 * | --- | --- |
 * | `no-state` | nothing: the state is in the process. The baseline. |
 * | `limits` | three limiter checks: the deployment, the caller and the route. |
 * | `session` | the limits and the read of the session of the caller. |
 * | `full` | the limits, the session and the cached decision of the access service. |
 *
 * The scenarios are interleaved: the load of the machine changes over the
 * time, so a backend that is measured at the end of the run is not
 * measured on a machine that is busier than the one that was measured
 * first.
 *
 * The numbers are the ones of the machine it runs on: they are a
 * measurement and not a promise. The targets of the deployment are in
 * `docs/capacity.md`.
 *
 *   bun run benchmark -- --redis redis://127.0.0.1:6379/0 \
 *                        --postgres postgres://127.0.0.1:5432/shuttle
 *
 * The size of the pool of the connections of a Postgres server is a knob
 * of the deployment: `--pool 30` measures a replica with a larger pool.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnv } from '../src/runtime/env'
import { createRuntime } from '../src/runtime/composition'
import { startUpstream } from '../services/upstream'
import { startAccessService } from '../services/access-fixture'
import { measure, reportTable, summarize, type Summary } from './measure'

interface Options {
  redis?: string
  postgres?: string
  host: string
  requests: number
  concurrency: number
  /** The number of the rounds of each scenario. */
  rounds: number
  /** The number of the connections of the pool of a replica. */
  poolMax: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    host: 'benchmark.shuttle.test',
    requests: 5_000,
    concurrency: 50,
    rounds: 1,
    poolMax: 10,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = argv[index + 1]
    switch (argument) {
      case '--redis':
        options.redis = value
        index++
        break
      case '--postgres':
        options.postgres = value
        index++
        break
      case '--host':
        options.host = value!
        index++
        break
      case '--requests':
        options.requests = Number(value)
        index++
        break
      case '--concurrency':
        options.concurrency = Number(value)
        index++
        break
      case '--rounds':
        options.rounds = Number(value)
        index++
        break
      case '--pool':
        options.poolMax = Number(value)
        index++
        break
      default:
        break
    }
  }
  return options
}

/** The backends the benchmark measures. */
interface Backend {
  name: string
  /** The url of the sessions and of the shared state, or undefined for the baseline. */
  url?: string
}

/** The scenarios of the benchmark, in the order they are run. */
const SCENARIOS = ['no-state', 'limits', 'session', 'full'] as const
type Scenario = (typeof SCENARIOS)[number]

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Runs one scenario against one backend.
 *
 * The gateway is started for the scenario, the traffic is run and the
 * gateway is stopped: the state of one scenario never touches the state of
 * the next one.
 */
async function runScenario(
  backend: Backend,
  scenario: Scenario,
  options: Options,
  upstreamUrl: string,
  accessUrl: string,
  configPath: string
): Promise<Summary> {
  const authenticated = scenario === 'session' || scenario === 'full'
  const workspace = scenario === 'full'

  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { auth: { mode: 'none' } },
        routes: [
          {
            id: 'benchmark',
            match: { host: options.host, path: workspace ? '/ws/{workspaceId}/' : '/' },
            upstream: upstreamUrl,
            auth: {
              mode: authenticated ? 'session' : 'none',
              ...(workspace ? { workspace: { param: 'workspaceId', requireUuid: true } } : {}),
            },
          },
        ],
      },
      null,
      2
    )
  )

  // The shared state of the scenario: the baseline keeps it in the process,
  // the other scenarios use the server under test.
  const useState = scenario !== 'no-state'
  const url = useState ? backend.url : 'memory://benchmark'

  const settings = readEnv({
    SHUTTLE_CONFIG: configPath,
    SHUTTLE_GATEWAY_HOST: '127.0.0.1',
    SHUTTLE_GATEWAY_PORT: '0',
    SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1',
    SHUTTLE_OIDC_CLIENT_ID: 'benchmark',
    SHUTTLE_OIDC_CLIENT_SECRET: 'benchmark-secret',
    SHUTTLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:1/auth/callback',
    SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
    SHUTTLE_ACCESS_URL: accessUrl,
    SHUTTLE_ACCESS_TOKEN: 'benchmark-access-token',
    SHUTTLE_ACCESS_CACHE_TTL_MS: '30000',
    SHUTTLE_SESSION_SECRET: 'benchmark-secret',
    SHUTTLE_SESSION_URL: url!,
    SHUTTLE_SHARED_STATE_URL: url!,
    SHUTTLE_LOG_LEVEL: 'error',
    SHUTTLE_METRICS_TOKEN: 'benchmark-metrics-token',
    // The limits are the point of the benchmark: they are the round trips
    // to the shared state.
    SHUTTLE_RATE_LIMIT_MAX: '600000',
    SHUTTLE_RATE_LIMIT_GLOBAL_MAX: '600000',
    SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX: '600000',
    SHUTTLE_RATE_LIMIT_TOTAL_MAX: '6000000',
    SHUTTLE_LOGIN_RATE_LIMIT_MAX: '0',
    SHUTTLE_POSTGRES_POOL_MAX: String(options.poolMax),
  })

  const runtime = await createRuntime(settings)
  runtime.config.apply(JSON.parse(await Bun.file(configPath).text()))
  const target = `http://127.0.0.1:${runtime.listener.port}`
  const path = workspace ? `/ws/${WORKSPACE_ID}/` : '/'

  try {
    // The session of the caller is created in the store of the gateway
    // itself: the session has to be found by the store of the gateway, and
    // the backend of the store is the one under test.
    let cookie: string | undefined
    if (authenticated) {
      const record = await runtime.sessions.create({ subject: 'user-alice' })
      cookie = `shuttle_session=${record.id}`
    }

    const measureOptions = {
      host: options.host,
      path,
      requests: options.requests,
      concurrency: options.concurrency,
      websockets: 0,
      cookie,
    }
    // A short run first, so the connections are warm and the state is
    // built before the measurement.
    await measure({ ...measureOptions, requests: Math.min(200, options.requests) }, target)
    const measurement = await measure(measureOptions, target)
    return summarize(scenario, backend.name, measurement, options.requests)
  } finally {
    await runtime.listener.stop(true)
    await runtime.close()
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const backends: Backend[] = [{ name: 'in-process' }]
  if (options.redis) backends.push({ name: 'redis', url: options.redis })
  if (options.postgres) backends.push({ name: 'postgres', url: options.postgres })
  if (backends.length === 1) {
    console.error('the benchmark needs at least one server: --redis <url> and/or --postgres <url>')
    process.exit(1)
  }

  const upstream = await startUpstream({ name: 'benchmark-upstream' })
  const access = await startAccessService({})
  const directory = await mkdtemp(join(tmpdir(), 'shuttle-benchmark-'))
  const configPath = join(directory, 'routes.json')

  const summaries: Summary[] = []
  try {
    // The scenarios are interleaved: the load of the machine changes over
    // the time, and a backend that is measured last must not be measured
    // on a machine that is busier than the one that was measured first.
    for (let round = 0; round < options.rounds; round++) {
      for (const scenario of SCENARIOS) {
        for (const backend of backends) {
          // The baseline does not depend on the server: it is measured
          // once.
          if (scenario === 'no-state' && backend.name !== backends[0]!.name) continue
          const summary = await runScenario(
            backend,
            scenario,
            options,
            upstream.url,
            access.url,
            configPath
          )
          summaries.push(summary)
        }
      }
    }
  } finally {
    await access.stop()
    await upstream.stop()
    await rm(directory, { recursive: true, force: true })
  }

  reportTable(summaries)
  console.log('')
  console.log('the numbers are the ones of this machine: they are a measurement and not a promise')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
