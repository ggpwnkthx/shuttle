import { describe, expect, test } from 'bun:test'
import {
  MINIMUM_RUNTIME_VERSION,
  assertRuntimeVersion,
  isRuntimeVersionSupported,
  parseRuntimeVersion,
} from './version'

describe('the version of the runtime', () => {
  test('the runtime of this process is the one the gateway needs', () => {
    expect(isRuntimeVersionSupported(Bun.version)).toBe(true)
    expect(() => assertRuntimeVersion(Bun.version)).not.toThrow()
  })

  test('the oldest runtime the gateway supports is the one of the contract', () => {
    expect(MINIMUM_RUNTIME_VERSION).toBe('1.4.3')
    expect(isRuntimeVersionSupported('1.4.3')).toBe(true)
    expect(isRuntimeVersionSupported('1.4.4')).toBe(true)
    expect(isRuntimeVersionSupported('1.5.0')).toBe(true)
    expect(isRuntimeVersionSupported('2.0.0')).toBe(true)
  })

  test('the older lines of the runtime are refused', () => {
    expect(isRuntimeVersionSupported('1.2.0')).toBe(false)
    expect(isRuntimeVersionSupported('1.2.23')).toBe(false)
    expect(isRuntimeVersionSupported('1.4.2')).toBe(false)
    expect(isRuntimeVersionSupported('1.3.9')).toBe(false)
    expect(isRuntimeVersionSupported('0.9.9')).toBe(false)
  })

  test('a prerelease of a supported version is supported', () => {
    expect(isRuntimeVersionSupported('1.4.3-canary.7')).toBe(true)
    expect(isRuntimeVersionSupported('1.2.0-canary.7')).toBe(false)
  })

  test('a version that cannot be parsed is not supported', () => {
    expect(isRuntimeVersionSupported('')).toBe(false)
    expect(isRuntimeVersionSupported('unknown')).toBe(false)
    expect(isRuntimeVersionSupported('1.4')).toBe(false)
    expect(parseRuntimeVersion('unknown')).toBeNull()
  })

  test('the gateway refuses to start on a runtime that is too old', () => {
    expect(() => assertRuntimeVersion('1.2.23')).toThrow(/1\.4\.3/)
    expect(() => assertRuntimeVersion('1.2.23')).toThrow(/1\.2\.23/)
    expect(() => assertRuntimeVersion('1.2.23')).toThrow(/runtime/)
  })
})
