import type { RelayerStore } from '../types.js'

export type MemoryTtlStoreOptions = {
  /** How long a remembered key stays known, in milliseconds. */
  ttlMs: number
}

/**
 * An in-memory dedup store that forgets a key after `ttlMs`. Doubles as a
 * per-key rate limiter. State is process-local and lost on restart.
 */
export const memoryTtlStore = <T>(options: MemoryTtlStoreOptions): RelayerStore<T> => {
  const seenAt = new Map<string, number>()
  const isLive = (timestamp: number): boolean => Date.now() - timestamp <= options.ttlMs
  return {
    has: async (key) => {
      const at = seenAt.get(key)
      if (at === undefined) return false
      if (isLive(at)) return true
      seenAt.delete(key)
      return false
    },
    remember: async (key) => {
      seenAt.set(key, Date.now())
    },
    prune: async () => {
      for (const [key, at] of seenAt) {
        if (!isLive(at)) seenAt.delete(key)
      }
    },
  }
}
