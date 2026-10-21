#!/usr/bin/env bun
/**
 * The measurement of the load of a gateway.
 *
 * The code is shared by `load.ts` and `benchmark.ts`: the two measure the
 * same thing, so the numbers they print can be compared.
 */

export interface Measurement {
  latencies: number[]
  errors: number
  durationMs: number
}

export interface MeasureOptions {
  host: string
  path: string
  requests: number
  concurrency: number
  websockets: number
  /** The cookie of the caller, when the route authenticates one. */
  cookie?: string
}

/** Runs the requests with a fixed number of them in flight. */
export async function measure(options: MeasureOptions, target: string): Promise<Measurement> {
  const latencies: number[] = []
  let errors = 0
  let index = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const current = index++
      if (current >= options.requests) return
      const started = performance.now()
      try {
        const headers: Record<string, string> = { host: options.host }
        if (options.cookie) headers.cookie = options.cookie
        const response = await fetch(`${target}${options.path}`, { headers })
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
export async function measureWebsockets(
  options: MeasureOptions,
  target: string
): Promise<Measurement> {
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

/** The percentile of a sorted list of measurements. */
export function percentile(sorted: number[], share: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share))
  return sorted[index]!
}

/** The summary of a measurement. */
export interface Summary {
  /** The name of the scenario. */
  label: string
  /** The backend the shared state of the scenario lived in. */
  backend: string
  requests: number
  durationMs: number
  perSecond: number
  p50: number
  p90: number
  p99: number
  max: number
  errors: number
}

/** Summarizes a measurement. */
export function summarize(
  label: string,
  backend: string,
  measurement: Measurement,
  requests: number
): Summary {
  const sorted = [...measurement.latencies].sort((a, b) => a - b)
  return {
    label,
    backend,
    requests,
    durationMs: measurement.durationMs,
    perSecond: (requests / measurement.durationMs) * 1000,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    errors: measurement.errors,
  }
}

/** Prints the summary of a measurement. */
export function report(summary: Summary): void {
  const line = [
    summary.label.padEnd(16),
    summary.backend.padEnd(10),
    `${summary.requests} requests`,
    `${summary.durationMs.toFixed(0)} ms`,
    `${summary.perSecond.toFixed(0)} req/s`,
    `p50 ${summary.p50.toFixed(1)} ms`,
    `p90 ${summary.p90.toFixed(1)} ms`,
    `p99 ${summary.p99.toFixed(1)} ms`,
    `max ${summary.max.toFixed(1)} ms`,
    `${summary.errors} errors`,
  ].join('  ')
  console.log(line)
}

/** Prints a table that compares several measurements. */
export function reportTable(rows: readonly Summary[]): void {
  if (rows.length === 0) return
  const header = [
    'scenario'.padEnd(22),
    'backend'.padEnd(10),
    'req/s'.padStart(9),
    'p50 ms'.padStart(9),
    'p90 ms'.padStart(9),
    'p99 ms'.padStart(9),
    'max ms'.padStart(9),
    'errors'.padStart(7),
  ].join('  ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of rows) {
    console.log(
      [
        row.label.padEnd(22),
        row.backend.padEnd(10),
        `${row.perSecond.toFixed(0)}`.padStart(9),
        `${row.p50.toFixed(1)}`.padStart(9),
        `${row.p90.toFixed(1)}`.padStart(9),
        `${row.p99.toFixed(1)}`.padStart(9),
        `${row.max.toFixed(1)}`.padStart(9),
        `${row.errors}`.padStart(7),
      ].join('  ')
    )
  }
}
