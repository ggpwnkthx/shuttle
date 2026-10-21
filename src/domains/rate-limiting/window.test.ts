import { describe, expect, test } from 'bun:test'
import {
  MAX_WINDOW_BUCKETS,
  bucketIndex,
  bucketSizeMs,
  evaluateWindow,
  windowBucketCount,
} from './index'

/**
 * The window of a caller.
 *
 * The window slides and it is counted in buckets. The buckets are the
 * moments every replica can compute, so the replicas count in the same
 * buckets.
 */
describe('the buckets of a window', () => {
  test('a window holds a bounded number of buckets', () => {
    expect(bucketSizeMs(60_000)).toBe(1_000)
    expect(windowBucketCount(60_000, 1_000)).toBe(MAX_WINDOW_BUCKETS)
    // A long window is not counted in more buckets either.
    expect(windowBucketCount(3_600_000, bucketSizeMs(3_600_000))).toBe(MAX_WINDOW_BUCKETS)
  })

  test('a short window keeps its own size', () => {
    expect(bucketSizeMs(100)).toBe(2)
    expect(windowBucketCount(100, 2)).toBe(50)
    expect(bucketSizeMs(1)).toBe(1)
    expect(bucketSizeMs(0)).toBe(1)
  })

  test('the index of a bucket is a moment every replica can compute', () => {
    expect(bucketIndex(960_000, 1_000)).toBe(960)
    expect(bucketIndex(960_999, 1_000)).toBe(960)
    expect(bucketIndex(961_000, 1_000)).toBe(961)
  })
})

describe('the evaluation of a window', () => {
  const windowMs = 60_000
  const bucketMs = 1_000

  test('a request under the limit is allowed', () => {
    const evaluation = evaluateWindow([{ index: 960, count: 1 }], 960_000, windowMs, bucketMs, 2)
    expect(evaluation.allowed).toBe(true)
    expect(evaluation.count).toBe(2)
    expect(evaluation.retryAfterMs).toBe(0)
  })

  test('a request over the limit is refused', () => {
    const evaluation = evaluateWindow([{ index: 960, count: 2 }], 960_000, windowMs, bucketMs, 2)
    expect(evaluation.allowed).toBe(false)
    expect(evaluation.count).toBe(2)
    // The bucket of the requests leaves the window one window later.
    expect(evaluation.retryAfterMs).toBe(60_000)
  })

  test('the buckets that left the window are not counted', () => {
    // The bucket 900 is out of the window of the moment 960.
    const evaluation = evaluateWindow(
      [
        { index: 900, count: 10 },
        { index: 960, count: 1 },
      ],
      960_000,
      windowMs,
      bucketMs,
      2
    )
    expect(evaluation.allowed).toBe(true)
    expect(evaluation.count).toBe(2)
  })

  test('the window slides: the budget of the last milliseconds is the budget', () => {
    // Two requests at the end of a fixed window and two at the beginning
    // of the next one are four requests in two milliseconds: a fixed
    // window lets them through, a sliding window does not.
    const evaluation = evaluateWindow([{ index: 959, count: 2 }], 960_000, windowMs, bucketMs, 2)
    expect(evaluation.allowed).toBe(false)
  })

  test('the wait is the time of the oldest requests that have to leave', () => {
    // The bucket 905 holds the request that has to leave the window for
    // the count to be under the limit.
    const evaluation = evaluateWindow(
      [
        { index: 905, count: 1 },
        { index: 960, count: 1 },
      ],
      960_000,
      windowMs,
      bucketMs,
      2
    )
    expect(evaluation.allowed).toBe(false)
    // The bucket 905 leaves the window at (905 + 60) seconds.
    expect(evaluation.retryAfterMs).toBe(5_000)
  })

  test('the wait covers every request that has to leave', () => {
    // The bucket 905 alone is not enough: the request of the bucket 960
    // is still counted when the bucket 905 leaves the window.
    const evaluation = evaluateWindow(
      [
        { index: 905, count: 1 },
        { index: 960, count: 1 },
      ],
      960_000,
      windowMs,
      bucketMs,
      1
    )
    expect(evaluation.allowed).toBe(false)
    expect(evaluation.retryAfterMs).toBe(60_000)
  })
})
