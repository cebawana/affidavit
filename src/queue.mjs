// A small review queue: at most `concurrency` jobs run at once, the rest wait
// their turn in order. Reviews only read screenshots that already exist, so
// running several alongside the browser cannot affect the app or its data.

export function createQueue(concurrency = 1) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a whole number of 1 or more, not ${concurrency}`)
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= concurrency || !waiting.length) return
    active++
    const { fn, resolve, reject } = waiting.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return {
    /** Runs `fn` when a slot is free; resolves with its result. */
    add: fn => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next() }),
    get waiting() { return waiting.length },
    get active() { return active },
  }
}

/**
 * A rate limit is the backend asking us to wait, not a verdict on the app.
 * Matched on the message because each backend words it differently.
 */
export function isRateLimit(err) {
  return /rate.?limit|usage.?limit|too many requests|\b429\b|\b529\b|overloaded|quota|at capacity|try again later/i.test(String(err?.message ?? err))
}

/**
 * Calls `fn`, and on a retryable error waits each delay in turn before trying
 * again. Once the delays are spent the last error is thrown to the caller,
 * who records it as "not reviewed" with the reason.
 */
export async function withRetry(fn, { retryable = isRateLimit, delays = [], sleep = ms => new Promise(r => setTimeout(r, ms)), onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= delays.length || !retryable(err)) throw err
      onRetry(err, delays[attempt], attempt + 1, delays.length)
      await sleep(delays[attempt])
    }
  }
}
