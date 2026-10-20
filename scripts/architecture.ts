#!/usr/bin/env bun
/**
 * The import boundary check of Shuttle.
 *
 * The domain organization of the specification is part of the implementation
 * contract: a domain owns its policy, the application orchestrates the
 * domains, the platform implements the ports of the domains and the runtime
 * is the only place where the concrete pieces are assembled.
 *
 * This script checks that contract on the source tree. It is run by the test
 * suite (`test/architecture/imports.test.ts`) and by the CI workflow, so a
 * violation fails the build instead of being noticed in a review.
 *
 * The rules are the ones of SPECS.md §14.3:
 *
 * 1. A domain is imported through its public entry point (`index.ts`).
 * 2. Routing, authentication and rate limiting depend on no other domain.
 * 3. Configuration may use the public schemas of routing and authentication.
 * 4. Workspace access may use the principal of authentication and the
 *    identifier types of routing.
 * 5. Forwarding may use the principal type of authentication.
 * 6. Proxying and the websockets may use the plans of forwarding.
 * 7. Core domain code imports no framework (Hono), no Bun api, no adapter,
 *    no application, no platform and no runtime.
 * 8. The application uses the public entry points of the domains and the
 *    observation interfaces, never a concrete adapter.
 * 9. The platform implements the ports of the domains, it makes no policy
 *    decision and it knows neither the application nor the runtime.
 * 10. The observation layer is independent of everything else.
 * 11. The runtime is the composition root: it may assemble everything.
 * 12. There are no catch-all directories and no import cycles.
 * 13. The framework of the application belongs to the application and the
 *     api of the runtime belongs to the platform of the runtime.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export interface SourceFile {
  /** Path of the file, relative to the root of the project. */
  path: string
  content: string
}

export interface Violation {
  /** The file the violation was found in. */
  file: string
  /** The identifier of the rule that was broken. */
  rule: string
  message: string
  /** The import that caused the violation, when there is one. */
  specifier?: string
}

const SRC = 'src'

/** The domains of the gateway and the domains they may use. */
export const DOMAIN_DEPENDENCIES: Record<string, readonly string[]> = {
  routing: [],
  configuration: ['routing', 'authentication'],
  authentication: [],
  'workspace-access': ['authentication', 'routing'],
  forwarding: ['authentication'],
  'rate-limiting': [],
  proxying: ['forwarding'],
  websockets: ['forwarding'],
}

/** The packages a core domain file may not import. */
const FORBIDDEN_DOMAIN_PACKAGES = [
  'hono',
  'bun',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:http2',
]

/** Directories that collect unrelated behaviour and are therefore refused. */
const FORBIDDEN_DIRECTORIES = [
  'utils',
  'util',
  'helpers',
  'helper',
  'services',
  'service',
  'repositories',
  'repository',
  'common',
  'shared',
  'misc',
]

export interface ArchitectureOptions {
  /** The root of the project (the directory that holds `src`). */
  root: string
}

/** Classifies a file by the layer it belongs to. */
interface Location {
  layer: 'domain' | 'app' | 'platform' | 'runtime' | 'observability' | 'entry' | 'unknown'
  /** The name of the domain, when the file belongs to one. */
  domain?: string
  /** True when the file is a concrete adapter of its domain. */
  adapter: boolean
  /** True when the file is a test of a domain. */
  test: boolean
}

export function locate(path: string): Location {
  const normalized = path.replace(/\\/g, '/')
  const isTest = normalized.endsWith('.test.ts')
  if (normalized === 'src/main.ts') return { layer: 'entry', adapter: false, test: isTest }
  if (normalized.startsWith('src/app/')) return { layer: 'app', adapter: false, test: isTest }
  if (normalized.startsWith('src/platform/')) {
    return { layer: 'platform', adapter: false, test: isTest }
  }
  if (normalized.startsWith('src/runtime/')) {
    return { layer: 'runtime', adapter: false, test: isTest }
  }
  if (normalized.startsWith('src/observability/')) {
    return { layer: 'observability', adapter: false, test: isTest }
  }
  const domainMatch = /^src\/domains\/([^/]+)\/(.*)$/.exec(normalized)
  if (domainMatch) {
    const domain = domainMatch[1]!
    const rest = domainMatch[2]!
    return { layer: 'domain', domain, adapter: rest.startsWith('adapters/'), test: isTest }
  }
  return { layer: 'unknown', adapter: false, test: isTest }
}

/** The imports of a file, with the position of the statement. */
function importsOf(file: SourceFile): { specifier: string; line: number }[] {
  const info = ts.preProcessFile(file.content, true, true)
  const found: { specifier: string; line: number }[] = []
  for (const imported of info.importedFiles) {
    found.push({
      specifier: imported.fileName,
      line: file.content.slice(0, imported.pos).split('\n').length,
    })
  }
  // `ts.preProcessFile` reports the static imports; a dynamic import is a
  // dependency as well and it is easy to miss.
  const dynamic = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let match = dynamic.exec(file.content)
  while (match !== null) {
    found.push({
      specifier: match[1]!,
      line: file.content.slice(0, match.index).split('\n').length,
    })
    match = dynamic.exec(file.content)
  }
  return found
}

/**
 * Resolves a relative import to a file of the project, when there is one.
 *
 * The resolution uses the set of the known files: an import of a module
 * that does not exist is a build error, not a boundary violation.
 */
function resolveRelative(
  from: string,
  specifier: string,
  known: ReadonlySet<string>
): string | null {
  const base = resolve(dirname(join(process.cwd(), from)), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    join(base, 'index.ts'),
    base.replace(/\.js$/, '.ts'),
    join(base.replace(/\.js$/, ''), 'index.ts'),
  ]
  for (const candidate of candidates) {
    const normalized = relative(process.cwd(), candidate).replace(/\\/g, '/')
    if (normalized.startsWith('..')) continue
    if (known.has(normalized)) return normalized
  }
  return null
}

/** The package of a bare import, without its sub path. */
function packageOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Reports whether a resolved path is inside a directory. */
function inside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`)
}

/**
 * Checks the architecture of a set of source files.
 *
 * The function is pure: it takes the files and returns the violations, so
 * the test suite can feed it a file that breaks a rule and see that the rule
 * is actually enforced.
 */
export function checkArchitecture(files: SourceFile[]): Violation[] {
  const violations: Violation[] = []
  const known = new Set(files.map((file) => file.path))
  const graph = new Map<string, string[]>()

  for (const file of files) {
    const location = locate(file.path)
    const edges: string[] = []
    for (const entry of importsOf(file)) {
      const { specifier } = entry
      const report = (rule: string, message: string): void => {
        violations.push({ file: file.path, rule, message, specifier })
      }

      // A bare import is a package. The rules about packages only concern
      // the core domain code, which stays free of frameworks.
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        if (location.layer === 'domain' && !location.adapter && !location.test) {
          const pkg = packageOf(specifier)
          if (FORBIDDEN_DOMAIN_PACKAGES.includes(pkg)) {
            report(
              'domain-core-imports-framework',
              `a core domain file may not import "${pkg}": the domains receive their dependencies through injected ports`
            )
          }
        }
        continue
      }

      const resolved = resolveRelative(file.path, specifier, known)
      if (!resolved) continue
      edges.push(resolved)

      const target = locate(resolved)

      // (7) Core domain code imports no application, platform or runtime
      // layer. The observation interfaces are allowed: a domain receives
      // the observation as it needs it.
      if (location.layer === 'domain' && !location.adapter && !location.test) {
        if (target.layer === 'app' || target.layer === 'platform' || target.layer === 'runtime') {
          report(
            'domain-core-imports-boundary',
            `a core domain file may not import the ${target.layer} layer ("${specifier}")`
          )
        }
      }

      // (1) A domain is imported through its public entry point.
      if (target.layer === 'domain' && target.domain !== location.domain) {
        const isPublicEntry = resolved === `src/domains/${target.domain}/index.ts`
        const isAdapterEntry =
          resolved === `src/domains/${target.domain}/adapters/index.ts` &&
          location.layer === 'runtime'
        if (!isPublicEntry && !isAdapterEntry) {
          report(
            'domain-import-not-public',
            `the ${location.domain ?? 'core'} layer may only use the public entry point of the "${target.domain}" domain ("${specifier}")`
          )
        }
      }

      // A concrete adapter belongs to the domain that owns it and to the
      // composition root, which is the only place that assembles them.
      if (target.adapter && !location.test) {
        const isAdapterEntry = resolved === `src/domains/${target.domain}/adapters/index.ts`
        if (location.layer === 'runtime') {
          if (!isAdapterEntry) {
            report(
              'runtime-imports-adapter-internals',
              `the composition root assembles the adapters of a domain through its adapter entry point ("${specifier}")`
            )
          }
        } else if (
          location.layer === 'domain' &&
          location.adapter &&
          location.domain === target.domain
        ) {
          // An adapter may use the internals of its own domain.
        } else if (location.layer === 'app') {
          report(
            'app-imports-adapter',
            `the application may not import a concrete adapter ("${specifier}")`
          )
        } else {
          report(
            'domain-imports-adapter',
            `the core code of a domain may not use a concrete adapter ("${specifier}")`
          )
        }
      }

      // (3) The dependency matrix of the domains.
      if (
        location.layer === 'domain' &&
        target.layer === 'domain' &&
        target.domain &&
        target.domain !== location.domain
      ) {
        const allowed = DOMAIN_DEPENDENCIES[location.domain ?? ''] ?? []
        if (!allowed.includes(target.domain)) {
          report(
            'domain-dependency-not-allowed',
            `the "${location.domain}" domain may not depend on the "${target.domain}" domain ("${specifier}")`
          )
        }
      }

      // (5) The public entry point of a domain holds no adapter.
      if (
        location.layer === 'domain' &&
        !location.adapter &&
        !location.test &&
        location.domain &&
        inside(resolved, `src/domains/${location.domain}/adapters`)
      ) {
        report(
          'domain-entry-uses-adapter',
          `the public entry point of the "${location.domain}" domain may not use its concrete adapters`
        )
      }

      // (8) The application uses the domains, never the adapters.
      // (the adapter rule above already covers it)

      // (9) The platform knows neither the application nor the runtime.
      if (location.layer === 'platform' && (target.layer === 'app' || target.layer === 'runtime')) {
        report(
          'platform-imports-boundary',
          `the platform may not import the ${target.layer} layer ("${specifier}")`
        )
      }

      // (10) The observation layer is independent.
      if (
        location.layer === 'observability' &&
        (target.layer === 'domain' ||
          target.layer === 'app' ||
          target.layer === 'platform' ||
          target.layer === 'runtime')
      ) {
        report(
          'observability-imports-boundary',
          `the observation layer may not import the ${target.layer} layer ("${specifier}")`
        )
      }
    }
    graph.set(
      file.path,
      edges.filter((edge) => known.has(edge))
    )
  }

  // (13) Hono belongs to the application and the api of the runtime belongs
  // to the platform of the runtime.
  for (const file of files) {
    const location = locate(file.path)
    if (location.test) continue
    if (location.layer !== 'app') {
      for (const entry of importsOf(file)) {
        const specifier = entry.specifier
        if (specifier === 'hono' || specifier.startsWith('hono/')) {
          violations.push({
            file: file.path,
            rule: 'hono-outside-app',
            message: 'the framework of the application belongs to the application layer',
            specifier,
          })
        }
      }
    }
    // The platform is the boundary of the runtime: the api of the runtime
    // (the listener, the sockets, the client of the shared state) belongs
    // to it and to nothing else.
    if (!file.path.startsWith('src/platform/') && usesBunApi(file)) {
      violations.push({
        file: file.path,
        rule: 'bun-api-outside-platform',
        message: 'the api of the runtime belongs to the platform of the runtime',
      })
    }
  }

  // (14) No import cycles.
  for (const cycle of findCycles(graph)) {
    violations.push({
      file: cycle[0]!,
      rule: 'import-cycle',
      message: `import cycle: ${cycle.join(' -> ')}`,
    })
  }

  return violations
}

/**
 * Reports whether a file uses the api of the runtime.
 *
 * The comments and the strings are not code: the scanner of the compiler
 * only reports the identifiers that the program really uses.
 */
function usesBunApi(file: SourceFile): boolean {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ESNext, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === 'Bun') {
      const parent = node.parent
      // A property of an object (`foo.Bun`) is not the api of the runtime.
      if (!parent || !ts.isPropertyAccessExpression(parent) || parent.name !== node) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Finds the cycles of a dependency graph. */
function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): void => {
    const current = state.get(node)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = stack.indexOf(node)
      if (start !== -1) cycles.push([...stack.slice(start), node])
      return
    }
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) visit(next)
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of graph.keys()) visit(node)
  return cycles
}

/** Reads every TypeScript file of the project. */
export async function loadSources(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      files.push({
        path: relative(root, path).replace(/\\/g, '/'),
        content: await readFile(path, 'utf8'),
      })
    }
  }
  await walk(join(root, SRC))
  return files
}

/** Reports the files of the project that are in no known layer. */
export function unlocatedFiles(files: SourceFile[]): string[] {
  return files.filter((file) => locate(file.path).layer === 'unknown').map((file) => file.path)
}

/** Reports the directories that collect unrelated behaviour. */
export async function findForbiddenDirectories(root: string): Promise<string[]> {
  const found: string[] = []
  const source = join(root, SRC)
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (FORBIDDEN_DIRECTORIES.includes(entry.name)) {
        found.push(relative(root, path).replace(/\\/g, '/'))
      }
      await walk(path)
    }
  }
  await walk(source)
  return found
}

/** Runs the check and prints the violations. */
export async function main(): Promise<number> {
  const root = resolve(import.meta.dir, '..')
  const sources = await loadSources(root)
  const violations = checkArchitecture(sources)
  const directories = await findForbiddenDirectories(root)
  for (const directory of directories) {
    violations.push({
      file: directory,
      rule: 'catch-all-directory',
      message: `"${directory}" collects unrelated behaviour: every piece of code belongs to a domain`,
    })
  }
  if (violations.length === 0) {
    console.log(`the import boundaries are respected (${sources.length} files)`)
    return 0
  }
  for (const violation of violations) {
    console.error(`${violation.file}: [${violation.rule}] ${violation.message}`)
  }
  console.error(`${violations.length} import boundary violations`)
  return 1
}

if (import.meta.main) {
  process.exit(await main())
}
