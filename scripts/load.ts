#!/usr/bin/env bun
/**
 * A load test of the gateway.
 *
 * By default the script starts a gateway and an upstream in one process and
 * measures the path a request takes through the gateway. With `--url` it
 * measures a gateway that is already running.
 *
 *   bun run load                      → 2000 requests, 50 at a time
 *   bun run load -- --requests 20000  → a longer run
 *   bun run load -- --url http://localhost:8080 --host api.shuttle.test
 *
 * The numbers it prints are the ones of the machine it runs on, they are a
 * measurement and not a promise.
 */
import { createRuntime } from '../src/runtime/runtime'
import { startServers } from '../src/server'
import { startUpstream } from '../services/upstream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Options {
  url?: string
  host: string
  path: string
  requests: number
  concurrency: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    host: 'load.shuttle.test',
    path: '/',
    requests: 2000,
    concurrency: 50,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--url':
        options.url = value
        i++
        break
      case '--host':
        options.host = value!
        i++
        break
      case '--path':
        options.path = value!
        i++
        break
      case '--requests':
        options.requests = Number(value)
        i++
        break
      case '--concurrency':
        options.concurrency = Number(value)
        i++
        break
      default:
        break
    }
  }
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
          ],
        },
        null,
        2
      )
    )

    const runtime = createRuntime({
      configPath,
      gatewayPort: 0,
      gatewayHost: '127.0.0.1',
      oidc: {
        issuer: 'http://127.0.0.1:1',
        clientId: 'load',
        redirectUri: 'http://127.0.0.1:1/auth/callback',
        allowInsecureIssuer: true,
      },
      access: { baseUrl: 'http://127.0.0.1:1' },
      sessionSecret: 'load-test-secret',
      session: {
        url: 'memory://load',
        keyPrefix: 'shuttle-load',
        ttlMs: 60_000,
        touchIntervalMs: 60_000,
        maxSessions: 100,
      },
      sharedStateKeyPrefix: 'shuttle-load',
      cookieSecure: false,
      logLevel: 'error',
      maxBodyBytes: 1024 * 1024,
      websocketMaxBufferedBytes: 64 * 1024,
      websocketMaxBufferedMessages: 20,
      websocketMaxPayloadBytes: 16 * 1024 * 1024,
      websocketBackpressureLimitBytes: 1024 * 1024,
      websocketPingIntervalMs: 30_000,
      websocketPongTimeoutMs: 90_000,
      websocketIdleTimeoutSeconds: 120,
      websocketMaxConnections: 1_000,
      websocketHandshakeTimeoutMs: 10_000,
      // The load test measures the gateway, not the limiter.
      rateLimitMax: 0,
      rateLimitWindowMs: 60_000,
      loginRateLimitMax: 0,
      loginRateLimitWindowMs: 60_000,
      allowedOrigins: [],
      csrfStrict: false,
      trustedProxies: [],
      externalProto: 'http',
      shutdownTimeoutMs: 5_000,
    })
    await runtime.config.reload()
    const servers = await startServers(runtime)
    target = `http://127.0.0.1:${servers.gateway.port}`
    stop = async () => {
      await servers.stop()
      await upstream.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }

  console.log(
    `target ${target}  host ${options.host}  path ${options.path}  concurrency ${options.concurrency}`
  )

  // A short run first, so the connections are warm before the measurement.
  await measure({ ...options, requests: Math.min(100, options.requests) }, target)
  const measurement = await measure(options, target)
  report('result', measurement, options.requests)

  await stop?.()

  if (measurement.errors > 0) {
    console.error(`${measurement.errors} requests failed`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
