import type { Hex } from 'viem'

/**
 * Client-seed custody — mirrors the Raffle salt-backup pattern in model/salts.ts.
 *
 * A player who loses their `clientSeed` before the round fires cannot play (the table can still
 * be refunded via the open floor, but the round is unplayable). We persist the seed in
 * localStorage keyed by `chainId + tableId` so a page refresh mid-session doesn't lose it.
 *
 * The store is injected so tests run on a Map-backed fake (same pattern as SaltStore).
 */

export type SeedStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PREFIX = 'msgboard-games:client-seed'

const seedKey = (chainId: number, tableId: Hex): string =>
  `${PREFIX}:${chainId}:${tableId.toLowerCase()}`

/** Persist a client seed for a given chain + table. */
export const saveClientSeed = (store: SeedStore, chainId: number, tableId: Hex, seed: Hex): void => {
  store.setItem(seedKey(chainId, tableId), seed)
}

/** Load a client seed. Returns null if not found. */
export const loadClientSeed = (store: SeedStore, chainId: number, tableId: Hex): Hex | null => {
  return (store.getItem(seedKey(chainId, tableId)) ?? null) as Hex | null
}

/** Remove a client seed (after a round completes successfully — the seed is no longer needed). */
export const removeClientSeed = (store: SeedStore, chainId: number, tableId: Hex): void => {
  store.removeItem(seedKey(chainId, tableId))
}
