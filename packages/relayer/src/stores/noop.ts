import type { RelayerStore } from '../types.js'

/** A dedup store that never deduplicates — for producers that intend to repost. */
export const noopStore = <T>(): RelayerStore<T> => ({
  has: async () => false,
  remember: async () => {},
})
