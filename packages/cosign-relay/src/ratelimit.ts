const DAY_MS = 24 * 60 * 60 * 1000

export type RateLimiter = {
  /** Consumes one request for `key`. Returns false once `perDay` has been used up for today (UTC). */
  take(key: string): boolean
}

/**
 * A simple in-memory, per-key daily token bucket (v1: single relay instance — no shared store).
 * `now` is injectable so tests can control day boundaries without real sleeps.
 */
export function createRateLimiter({ perDay, now = () => Date.now() }: { perDay: number; now?: () => number }): RateLimiter {
  const usage = new Map<string, { day: number; count: number }>()
  const utcDay = (ms: number) => Math.floor(ms / DAY_MS)

  return {
    take(key: string): boolean {
      const day = utcDay(now())
      const entry = usage.get(key)
      if (!entry || entry.day !== day) {
        usage.set(key, { day, count: 1 })
        return true
      }
      if (entry.count >= perDay) return false
      entry.count += 1
      return true
    },
  }
}
