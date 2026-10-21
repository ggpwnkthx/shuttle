/**
 * The version of the release and the version of the runtime.
 *
 * The version of the release is reported by the health endpoint, so an
 * operator knows what is running without reading the logs. It is the
 * version of the release; it is changed with the release and not with the
 * code.
 *
 * The version of the runtime is a contract of its own: the gateway relies
 * on boundaries of the runtime that are not observable on the older lines
 * (the early answer of an upstream while the upload runs, the cancellation
 * of the producer of the body, the refusal of the handshake of an upstream
 * websocket and the upgrade of the caller with the headers of the gateway).
 * The measurements are in `docs/runtime.md`, and the gateway refuses to
 * start on a runtime that does not have them: a gateway that starts on a
 * runtime it cannot rely on answers in ways the specification does not
 * describe, and the difference is only visible in production.
 */
import { runtimeVersion } from '../platform/bun/runtime'

export const VERSION = '0.4.0'

/**
 * The oldest runtime the gateway is built, tested and released with.
 *
 * The contract states `Bun ≥ 1.4.3`: the boundaries the specification
 * relies on are not observable on the 1.2 line.
 */
export const MINIMUM_RUNTIME_VERSION = '1.4.3'

/** A version of the runtime, split in its parts. */
export interface RuntimeVersion {
  major: number
  minor: number
  patch: number
}

/**
 * Parses a version of the runtime.
 *
 * A prerelease (`1.5.0-canary.7`) is the version it is built on: the
 * suffix is ignored, because the parts that matter are the ones that
 * decide whether the boundaries are observable.
 */
export function parseRuntimeVersion(version: string): RuntimeVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Reports whether a version of the runtime is the one the gateway needs.
 *
 * A version that cannot be parsed is not supported: the gateway does not
 * guess what an unknown version can do.
 */
export function isRuntimeVersionSupported(version: string): boolean {
  const parsed = parseRuntimeVersion(version)
  const minimum = parseRuntimeVersion(MINIMUM_RUNTIME_VERSION)
  if (!parsed || !minimum) return false
  if (parsed.major !== minimum.major) return parsed.major > minimum.major
  if (parsed.minor !== minimum.minor) return parsed.minor > minimum.minor
  return parsed.patch >= minimum.patch
}

/**
 * Refuses a runtime that does not have the boundaries the gateway needs.
 *
 * The gateway stops instead of starting: the boundaries that are missing
 * are observable only in production, and a gateway that answers in a way
 * its specification does not describe is worse than a gateway that does
 * not answer at all.
 */
export function assertRuntimeVersion(version: string = runtimeVersion()): void {
  if (isRuntimeVersionSupported(version)) return
  throw new Error(
    `the gateway needs Bun ${MINIMUM_RUNTIME_VERSION} or later and this runtime is ${version}: the boundaries the gateway relies on — the early answer of an upstream while the upload runs, the cancellation of the producer of the body, the refusal of the handshake of an upstream websocket and the upgrade of the caller with the headers of the gateway — are not observable on this version (docs/runtime.md)`
  )
}
