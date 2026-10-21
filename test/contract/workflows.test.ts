import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'

/**
 * The workflows of the repository.
 *
 * The steps of a job read the outputs of the other steps with
 * `steps.<id>.outputs.<name>`, and the jobs read the outputs of the other
 * jobs with `needs.<job>.outputs.<name>`.
 *
 * An output that is written by a step that has **no id** is not readable:
 * the expression is empty, and the step that reads it fails long after
 * the mistake was made — the build of the image fails with an empty tag,
 * which says nothing about the reason.
 *
 * The check below is the guard: every reference has to point at a step
 * that writes the output it names, and at a job that declares it.
 */
const WORKFLOWS = join(import.meta.dir, '..', '..', '.github', 'workflows')

/** A step of a workflow, in the shape the check needs. */
interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

/** The outputs a step writes to the environment of the runner. */
function outputsOf(step: Step): string[] {
  if (!step.run) return []
  const names = new Set<string>()
  // `echo "name=value" >> "$GITHUB_OUTPUT"` and its variants.
  for (const match of step.run.matchAll(
    /echo\s+"?([A-Za-z0-9_-]+)=[^"]*"?\s*>>\s*"?\$GITHUB_OUTPUT"?/g
  )) {
    names.add(match[1]!)
  }
  return [...names]
}

/** Every string of a value, wherever it is. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsOf)
  }
  return []
}

describe('the workflows of the repository', () => {
  test('the outputs the steps read are the outputs the steps write', async () => {
    const files = (await readdir(WORKFLOWS)).filter((name) => name.endsWith('.yml'))
    expect(files.length).toBeGreaterThan(0)

    const findings: string[] = []
    for (const file of files) {
      const text = await readFile(join(WORKFLOWS, file), 'utf8')
      const docs = parseAllDocuments(text)
      expect(docs[0]?.errors).toEqual([])
      const workflow = docs[0]!.toJS() as {
        jobs: Record<string, { steps?: Step[] }>
      }

      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? []
        const ids = new Set(steps.map((step) => step.id).filter(Boolean) as string[])
        const written = new Map<string, string[]>()
        for (const step of steps) {
          if (!step.id) continue
          written.set(step.id, outputsOf(step))
        }

        for (const step of steps) {
          const texts = [step.run ?? '', ...stringsOf(step.with)]
          for (const text of texts) {
            // steps.<id>.outputs.<name>
            for (const match of text.matchAll(
              /steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g
            )) {
              const [, id, name] = match
              if (!ids.has(id!)) {
                findings.push(
                  `${file}: the job ${jobName} reads steps.${id}.outputs.${name} and no step of the job has the id ${id}`
                )
                continue
              }
              const names = written.get(id!) ?? []
              if (!names.includes(name!)) {
                findings.push(
                  `${file}: the job ${jobName} reads steps.${id}.outputs.${name} and the step ${id} writes ${
                    names.length ? names.join(', ') : 'nothing'
                  }`
                )
              }
            }
          }
        }
      }
    }
    expect(findings).toEqual([])
  })

  test('the outputs the jobs read are the outputs the jobs declare', async () => {
    const files = (await readdir(WORKFLOWS)).filter((name) => name.endsWith('.yml'))
    const findings: string[] = []

    for (const file of files) {
      const text = await readFile(join(WORKFLOWS, file), 'utf8')
      const workflow = parseAllDocuments(text)[0]!.toJS() as {
        jobs: Record<string, { outputs?: Record<string, unknown>; steps?: Step[] }>
      }
      const jobs = workflow.jobs ?? {}

      for (const [jobName, job] of Object.entries(jobs)) {
        for (const step of job.steps ?? []) {
          const texts = [step.run ?? '', ...stringsOf(step.with)]
          for (const text of texts) {
            // needs.<job>.outputs.<name>
            for (const match of text.matchAll(
              /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g
            )) {
              const [, needed, name] = match
              const target = jobs[needed!]
              if (!target) {
                findings.push(
                  `${file}: the job ${jobName} reads needs.${needed}.outputs.${name} and no job has that name`
                )
                continue
              }
              const declared = target.outputs ?? {}
              if (!Object.keys(declared).includes(name!)) {
                findings.push(
                  `${file}: the job ${jobName} reads needs.${needed}.outputs.${name} and the job ${needed} declares ${
                    Object.keys(declared).join(', ') || 'nothing'
                  }`
                )
              }
            }
          }
        }
      }
    }
    expect(findings).toEqual([])
  })
})
