import { describe, expect, test } from 'bun:test'
import { AdmissionController } from './admission'

describe('the admission of the requests', () => {
  test('a slot is taken and given back', () => {
    const admission = new AdmissionController({ max: 2 })
    expect(admission.activeCount).toBe(0)
    const release = admission.tryAcquire()
    expect(release).not.toBeNull()
    expect(admission.activeCount).toBe(1)
    release?.()
    expect(admission.activeCount).toBe(0)
  })

  test('a request that does not fit is refused', () => {
    const admission = new AdmissionController({ max: 1 })
    const first = admission.tryAcquire()
    expect(first).not.toBeNull()
    // The second request does not fit: it is refused instead of waiting.
    expect(admission.tryAcquire()).toBeNull()
    first?.()
    // The room that was refused is not lost: the slot is given back.
    expect(admission.tryAcquire()).not.toBeNull()
  })

  test('giving a slot back twice does not make room for a request that does not exist', () => {
    const admission = new AdmissionController({ max: 1 })
    const release = admission.tryAcquire()
    release?.()
    release?.()
    expect(admission.activeCount).toBe(0)
    expect(admission.tryAcquire()).not.toBeNull()
  })

  test('an admission without a limit lets every request in', () => {
    const admission = new AdmissionController({ max: 0 })
    expect(admission.enabled).toBe(false)
    const releases: (() => void)[] = []
    for (let index = 0; index < 100; index += 1) {
      const release = admission.tryAcquire()
      expect(release).not.toBeNull()
      releases.push(release!)
    }
    expect(admission.activeCount).toBe(100)
    for (const release of releases) release()
    expect(admission.activeCount).toBe(0)
  })
})
