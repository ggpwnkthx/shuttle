#!/usr/bin/env bun
/**
 * A load test of the gateway.
 *
 * By default the script starts a gateway and an upstream in one process and
 * measures the path a request takes through the gateway. With `--url` it
 * measures a gateway that is already running.
 *
 *   bun run load                      → 5000 requests, 50 at a time
 *   bun run load -- --requests 20000  → a longer run
 *   bun run load -- --url http://localhost:8080 --host api.shuttle.test
 *   bun run load -- --websockets 500  → the websockets instead of the requests
 *
 * The numbers it prints are the ones of the machine it runs on: they are a
 * measurement and not a promise. The targets of the deployment are in
 * docs/capacity.md.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnv } from '../src/runtime/env'
import { createRuntime } from '../src/runtime/composition'
import { startUpstream } from '../services/upstream'

interface Options {
  url?: string
  host: string
  path: string
  requests: number
  concurrency: number
  websockets: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    host: 'load.shuttle.test',
    path: '/',
    requests: 5000,
    concurrency: 50,
    websockets: 0,
  }
  let pathGiven = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = argv[index + 1]
    switch (argument) {
      case '--url':
        options.url = value
        index++
        break
      case '--host':
        options.host = value!
        index++
        break
      case '--path':
        options.path = value!
        pathGiven = true
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
      case '--websockets':
        options.websockets = Number(value)
        index++
        break
      default:
        break
    }
  }
  // The websockets live on their own route of the configuration of the
  // script.
  if (options.websockets > 0 && !pathGiven) options.path = '/socket/'
  return options
}

interface Measurement {
  latencies: number[]
  errors: number
  durationMs: number
}

/** Runs the requests with a fixed number of them in flight. */
async function measure(options: Options, target: string): Promise<Measurement> {
  const latencies: number[] = []
  let errors = 0
  let index = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const current = index++
      if (current >= options.requests) return
      const started = performance.now()
      try {
        const response = await fetch(`${target}${options.path}`, {
          headers: { host: options.host },
        })
        await response.arrayBuffer()
        if (!response.ok) errors += 1
      } catch {
        errors += 1
      }
      latencies.push(performance.now() - started)
    }
  }

  const started = performance.now()
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.requests) }, () => worker())
  )
  return { latencies, errors, durationMs: performance.now() - started }
}

/** Opens the websockets and keeps them open for a moment. */
async function measureWebsockets(options: Options, target: string): Promise<Measurement> {
  const latencies: number[] = []
  let errors = 0
  const started = performance.now()
  const sockets: WebSocket[] = []

  await Promise.all(
    Array.from({ length: options.websockets }, async () => {
      const opened = performance.now()
      try {
        const socket = new WebSocket(`${target.replace('http://', 'ws://')}${options.path}`)
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve()
          socket.onerror = () => reject(new Error('the connection failed'))
        })
        latencies.push(performance.now() - opened)
        sockets.push(socket)
      } catch {
        errors += 1
      }
    })
  )

  // The connections stay open: the capacity of the deployment is the number
  // of connections that can be open at the same time.
  await Bun.sleep(1000)
  for (const socket of sockets) socket.close()
  return { latencies, errors, durationMs: performance.now() - started }
}

function percentile(sorted: number[], share: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share))
  return sorted[index]!
}

function report(name: string, measurement: Measurement, requests: number): void {
  const sorted = [...measurement.latencies].sort((a, b) => a - b)
  const perSecond = (requests / measurement.durationMs) * 1000
  const line = [
    name.padEnd(12),
    `${requests} requests`,
    `${measurement.durationMs.toFixed(0)} ms`,
    `${perSecond.toFixed(0)} req/s`,
    `p50 ${percentile(sorted, 0.5).toFixed(1)} ms`,
    `p90 ${percentile(sorted, 0.9).toFixed(1)} ms`,
    `p99 ${percentile(sorted, 0.99).toFixed(1)} ms`,
    `max ${(sorted.at(-1) ?? 0).toFixed(1)} ms`,
    `${measurement.errors} errors`,
  ].join('  ')
  console.log(line)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  let target = options.url
  let stop: (() => Promise<void>) | null = null

  if (!target) {
    // The gateway and the upstream run in this process, the measurement is
    // the one of the gateway alone.
    const upstream = await startUpstream({ name: 'load-upstream' })
    const directory = await mkdtemp(join(tmpdir(), 'shuttle-load-'))
    const configPath = join(directory, 'routes.json')
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          defaults: { auth: { mode: 'none' } },
          routes: [
            {
              id: 'load',
              match: { host: options.host, path: '/' },
              upstream: upstream.url,
              auth: { mode: 'none' },
            },
            {
              id: 'load-socket',
              // The websocket client of the runtime cannot set the host of
              // the request, so the route matches every host.
              match: { host: '*', path: '/socket/' },
              upstream: upstream.url,
              auth: { mode: 'none' },
              websocket: true,
            },
          ],
        },
        null,
        2
      )
    )

    const settings = readEnv({
      SHUTTLE_CONFIG: configPath,
      SHUTTLE_GATEWAY_HOST: '127.0.0.1',
      SHUTTLE_GATEWAY_PORT: '0',
      SHUTTLE_OIDC_ISSUER: 'http://127.0.0.1:1',
      SHUTTLE_OIDC_CLIENT_ID: 'load',
      SHUTTLE_OIDC_CLIENT_SECRET: 'load-test-secret',
      SHUTTLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:1/auth/callback',
      SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
      SHUTTLE_ACCESS_URL: 'http://127.0.0.1:1',
      SHUTTLE_SESSION_SECRET: 'load-test-secret',
      SHUTTLE_SESSION_URL: 'memory://load',
      SHUTTLE_LOG_LEVEL: 'error',
      SHUTTLE_METRICS_TOKEN: 'load-metrics-token',
      // The load test measures the gateway, not the limiter.
      SHUTTLE_RATE_LIMIT_MAX: '0',
      SHUTTLE_RATE_LIMIT_GLOBAL_MAX: '0',
      SHUTTLE_LOGIN_RATE_LIMIT_MAX: '0',
    })
    const runtime = await createRuntime(settings)
    runtime.config.apply(JSON.parse(await Bun.file(configPath).text()))
    target = `http://127.0.0.1:${runtime.listener.port}`
    stop = async () => {
      await runtime.listener.stop(true)
      await runtime.close()
      await upstream.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }

  console.log(
    `target ${target}  host ${options.host}  path ${options.path}  concurrency ${options.concurrency}`
  )

  if (options.websockets > 0) {
    const measurement = await measureWebsockets(options, target)
    report('websockets', measurement, options.websockets)
  } else {
    // A short run first, so the connections are warm before the measurement.
    await measure({ ...options, requests: Math.min(200, options.requests) }, target)
    const measurement = await measure(options, target)
    report('requests', measurement, options.requests)
  }

  await stop?.()

  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
