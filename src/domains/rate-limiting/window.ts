/**
 * The window of a caller.
 *
 * The window **slides**: the count of a caller is the number of its requests
 * in the last `windowMs` milliseconds, and not the number of its requests
 * since the last boundary of the clock.
 *
 * A fixed window has a property that a limit does not want: a caller that
 * sends its whole budget at the end of a window and its whole budget again
 * at the beginning of the next one crosses the gateway twice as fast as the
 * limit allows. The window of the gateway slides, so the budget of a caller
 * is the budget of the last `windowMs` milliseconds, always.
 *
 * The window is counted in **buckets**: it is divided into buckets of
 * `bucketSizeMs` milliseconds, and the count of the window is the sum of the
 * counts of the buckets that are in it. Two properties matter:
 *
 * - the state of a caller does not grow with its traffic: a window holds at
 *   most `MAX_WINDOW_BUCKETS` buckets, whatever the rate of the caller;
 * - the boundary of a bucket is a moment every replica can compute, so the
 *   replicas of a deployment count in the same buckets and the limit of the
 *   deployment is the limit of the configuration.
 *
 * The count is exact to the bucket: a request that is counted in the
 * bucket of its moment stays in the window until that bucket leaves it.
 */

/** The number of buckets a window holds at most. */
export const MAX_WINDOW_BUCKETS = 60

/**
 * The size of a bucket, in milliseconds.
 *
 * A window is divided into at most `MAX_WINDOW_BUCKETS` buckets, so the
 * state of a caller is bounded. A short window keeps its own size: a
 * window of a second is counted in buckets of a few milliseconds.
 */
export function bucketSizeMs(windowMs: number): number {
  if (windowMs <= 0) return 1
  return Math.max(1, Math.ceil(windowMs / MAX_WINDOW_BUCKETS))
}

/** The number of buckets of a window. */
export function windowBucketCount(windowMs: number, bucketMs: number): number {
  return Math.max(1, Math.ceil(windowMs / bucketMs))
}

/** The index of the bucket a moment belongs to. */
export function bucketIndex(now: number, bucketMs: number): number {
  return Math.floor(now / bucketMs)
}

/** A bucket of a window and the requests it holds. */
export interface WindowBucket {
  /** The index of the bucket. */
  index: number
  /** The requests of the bucket. */
  count: number
}

/** The result of the evaluation of a window. */
export interface WindowEvaluation {
  /** The requests in the window, the counted one included. */
  count: number
  /** True when a request may be counted. */
  allowed: boolean
  /** How long the caller has to wait, in milliseconds. */
  retryAfterMs: number
}

/**
 * Evaluates the window of a caller.
 *
 * The buckets that left the window are ignored: a request of a bucket that
 * is out of the window is not counted any more.
 *
 * A request that is over the limit is not counted, so a client that keeps
 * hammering does not push the window further away.
 */
export function evaluateWindow(
  buckets: readonly WindowBucket[],
  now: number,
  windowMs: number,
  bucketMs: number,
  max: number
): WindowEvaluation {
  const count = windowBucketCount(windowMs, bucketMs)
  const current = bucketIndex(now, bucketMs)
  const oldest = current - count + 1
  const inWindow = buckets
    .filter((bucket) => bucket.index >= oldest && bucket.index <= current)
    .sort((left, right) => left.index - right.index)

  let total = 0
  for (const bucket of inWindow) total += bucket.count

  if (total < max) {
    return { count: total + 1, allowed: true, retryAfterMs: 0 }
  }

  // The caller has to wait for the oldest requests of the window to leave
  // it. A bucket leaves the window when the window has moved past it, and
  // the requests it holds leave with it. The earliest moment the count is
  // under the limit is therefore the moment the oldest bucket that holds
  // enough requests leaves the window.
  const needed = total - (max - 1)
  let prefix = 0
  // The last resort: the caller waits for the whole window to pass.
  let retryAfterMs = (current + count) * bucketMs - now
  for (const bucket of inWindow) {
    if (prefix + bucket.count >= needed) {
      retryAfterMs = (bucket.index + count) * bucketMs - now
      break
    }
    prefix += bucket.count
  }
  return { count: total, allowed: false, retryAfterMs }
}
