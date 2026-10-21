import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'

/**
 * The manifests of the deployment.
 *
 * A manifest that does not parse is a manifest that does not apply, and a
 * deployment without the probes, without the grace period or without the
 * secrets is a deployment that behaves differently from the one of the
 * documentation. The manifests are checked here, in the CI, so a mistake is
 * a failing build and not a surprise during a rollout.
 */
const directory = join(import.meta.dir, '..', '..', 'deploy', 'kubernetes')

/** Every document of every manifest of the directory. */
async function documents(): Promise<
  { file: string; index: number; body: Record<string, unknown> }[]
> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.yaml'))
  const parsed: { file: string; index: number; body: Record<string, unknown> }[] = []
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8')
    const docs = parseAllDocuments(text)
    for (const doc of docs) {
      if (doc.errors.length > 0) {
        throw new Error(`${file} does not parse: ${doc.errors[0]?.message}`)
      }
      const body = doc.toJS() as Record<string, unknown> | null
      if (body) parsed.push({ file, index: parsed.length, body })
    }
  }
  return parsed
}

/** The document of a kind. */
async function ofKind(kind: string): Promise<Record<string, unknown>> {
  const all = await documents()
  const found = all.find((entry) => entry.body.kind === kind)
  if (!found) throw new Error(`no document of the kind "${kind}"`)
  return found.body
}

describe('the manifests of the deployment', () => {
  test('every manifest parses', async () => {
    const all = await documents()
    expect(all.length).toBeGreaterThan(5)
  })

  test('the deployment has the probes of the specification', async () => {
    const deployment = await ofKind('Deployment')
    const spec = deployment.spec as Record<string, unknown>
    const template = spec.template as Record<string, unknown>
    const pod = template.spec as Record<string, unknown>
    const container = (pod.containers as Record<string, unknown>[])[0]!
    // The health is the liveness, the readiness is the readiness: the
    // gateway that cannot serve the traffic has to leave the rotation.
    expect((container.livenessProbe as Record<string, unknown>).httpGet).toEqual({
      path: '/healthz',
      port: 'http',
    })
    expect((container.readinessProbe as Record<string, unknown>).httpGet).toEqual({
      path: '/readyz',
      port: 'http',
    })
    expect(container.startupProbe).toBeDefined()
  })

  test('the grace period is longer than the deadline of the drain', async () => {
    const deployment = await ofKind('Deployment')
    const spec = deployment.spec as Record<string, unknown>
    const template = spec.template as Record<string, unknown>
    const pod = template.spec as Record<string, unknown>
    const container = (pod.containers as Record<string, unknown>[])[0]!
    const env = (container.env as { name: string; value?: string }[]).filter(
      (entry) => entry.name === 'SHUTTLE_SHUTDOWN_TIMEOUT_MS'
    )
    const drainMs = Number(env[0]?.value ?? '15000')
    // The pod has to stay alive long enough for the gateway to close its
    // websockets and to let the requests in flight finish.
    expect(Number(pod.terminationGracePeriodSeconds)).toBeGreaterThan(drainMs / 1000)
  })

  test('the secrets of the deployment come from the secret store', async () => {
    const deployment = await ofKind('Deployment')
    const spec = deployment.spec as Record<string, unknown>
    const template = spec.template as Record<string, unknown>
    const pod = template.spec as Record<string, unknown>
    const container = (pod.containers as Record<string, unknown>[])[0]!
    const env = container.env as {
      name: string
      value?: string
      valueFrom?: { secretKeyRef?: { name: string; key: string } }
    }[]
    const secretNames = [
      'SHUTTLE_SESSION_SECRET',
      'SHUTTLE_OIDC_CLIENT_SECRET',
      'SHUTTLE_ACCESS_TOKEN',
      'SHUTTLE_SESSION_URL',
      'SHUTTLE_SHARED_STATE_URL',
      'SHUTTLE_METRICS_TOKEN',
    ]
    for (const name of secretNames) {
      const entry = env.find((candidate) => candidate.name === name)
      expect(entry, `${name} is not set`).toBeDefined()
      // The value of a secret is never written in the manifest.
      expect(entry?.value).toBeUndefined()
      expect(entry?.valueFrom?.secretKeyRef?.name).toBe('shuttle-secrets')
    }
  })

  test('the container is hardened and it writes nothing', async () => {
    const deployment = await ofKind('Deployment')
    const spec = deployment.spec as Record<string, unknown>
    const template = spec.template as Record<string, unknown>
    const pod = template.spec as Record<string, unknown>
    const container = (pod.containers as Record<string, unknown>[])[0]!
    const security = container.securityContext as Record<string, unknown>
    expect(security.readOnlyRootFilesystem).toBe(true)
    expect(security.allowPrivilegeEscalation).toBe(false)
    expect((security.capabilities as { drop: string[] }).drop).toContain('ALL')
    expect((pod.securityContext as Record<string, unknown>).runAsNonRoot).toBe(true)
  })

  test('the route table of the deployment is valid', async () => {
    const configMap = await ofKind('ConfigMap')
    const routes = JSON.parse((configMap.data as Record<string, string>)['routes.json']!)
    expect(routes.version).toBe(1)
    // An upstream of a route may not carry a query string and it may not
    // carry a fragment: the configuration of the gateway refuses it.
    for (const route of routes.routes as { upstream: string }[]) {
      const url = new URL(route.upstream)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    }
  })

  test('the stack of a single host asks for the secrets and holds no fixture', async () => {
    const text = await readFile(
      join(import.meta.dir, '..', '..', 'deploy', 'compose.production.yaml'),
      'utf8'
    )
    const docs = parseAllDocuments(text)
    expect(docs[0]?.errors).toEqual([])
    const stack = docs[0]!.toJS() as {
      services: Record<string, { image: string; environment: Record<string, string> }>
    }
    // The stack of a deployment holds the gateway and the shared state, and
    // nothing else: the fixtures are not part of a deployment. The shared
    // state is a Redis server or a Postgres server; the Postgres one is
    // behind a profile, so it is not started by default.
    expect(Object.keys(stack.services).sort()).toEqual(['gateway', 'postgres', 'redis'])
    expect(stack.services.postgres!.image).toContain('postgres')
    // The Postgres service is not part of the default stack: a deployment
    // brings its own database.
    expect((stack.services.postgres as { profiles?: string[] }).profiles).toEqual(['postgres'])
    const gateway = stack.services.gateway!
    expect(gateway.image).toContain('ghcr.io/ggpwnkthx/shuttle')
    // The secrets of the deployment are not in the file: the stack refuses
    // to start without them.
    expect(gateway.environment.SHUTTLE_SESSION_SECRET).toContain('?')
    expect(gateway.environment.SHUTTLE_OIDC_CLIENT_SECRET).toContain('?')
    expect(gateway.environment.SHUTTLE_ACCESS_TOKEN).toContain('?')
    expect(gateway.environment.SHUTTLE_METRICS_TOKEN).toContain('?')
    // The gateway refuses to start in production without a rate limit.
    expect(gateway.environment.SHUTTLE_RATE_LIMIT_TOTAL_MAX).toBeTruthy()
  })

  test('the deployment sets at least one rate limit', async () => {
    // The gateway refuses to start in production without a rate limit: a
    // manifest that does not set one would not start.
    const deployment = await ofKind('Deployment')
    const spec = deployment.spec as Record<string, unknown>
    const template = spec.template as Record<string, unknown>
    const pod = template.spec as Record<string, unknown>
    const container = (pod.containers as Record<string, unknown>[])[0]!
    const env = container.env as { name: string; value?: string }[]
    const limits = env.filter((entry) => entry.name.startsWith('SHUTTLE_RATE_LIMIT_'))
    expect(limits.length).toBeGreaterThan(0)
    const enabled = limits
      .filter((entry) => entry.name.endsWith('_MAX'))
      .some((entry) => Number(entry.value ?? '0') > 0)
    expect(enabled).toBe(true)
  })

  test('the ingress does not buffer the bodies and it keeps the websockets open', async () => {
    const ingress = await ofKind('Ingress')
    const metadata = ingress.metadata as { annotations: Record<string, string> }
    const annotations = metadata.annotations
    expect(annotations['nginx.ingress.kubernetes.io/proxy-buffering']).toBe('off')
    expect(annotations['nginx.ingress.kubernetes.io/proxy-request-buffering']).toBe('off')
    expect(Number(annotations['nginx.ingress.kubernetes.io/proxy-read-timeout'])).toBeGreaterThan(
      60
    )
  })
})
