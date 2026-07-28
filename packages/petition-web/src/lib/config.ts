import type { Hex } from 'viem'
import { deployments } from '@msgboard/petition'

/**
 * Deployment-configurable endpoints + chain metadata for petition-web. Every base URL here reads
 * from a `VITE_*` env var (falling back to a sensible localhost default) — nothing is hard-coded
 * deeper in the app.
 */

/**
 * The petition read-side (`@msgboard/history`'s `/petition/*` group, Task C) — the CAPTURED
 * (posted-but-unverified) source: directory, signatures, tally. Local dev default matches the
 * history server's README example port (4040).
 */
export const PETITION_READ_BASE: string = import.meta.env.VITE_PETITION_READ_BASE ?? 'http://localhost:4040'

/**
 * The settlement indexer (Ponder, Task D) GraphQL endpoint — the ON-CHAIN (settled) source. Empty
 * by default: the indexer isn't guaranteed deployed yet, and an empty base degrades cleanly to
 * "no settled signers known" (outstanding = all verified-captured) rather than guessing a URL.
 */
export const PETITION_INDEXER_URL: string = import.meta.env.VITE_PETITION_INDEXER_URL ?? ''

/**
 * The PetitionSignatures verifier contract address, per chain — read from `VITE_PETITION_ADDR_*`
 * (explicit literal `import.meta.env.X` accesses so Vite can statically inline them), falling back
 * to `@msgboard/petition`'s `deployments` map if populated. Returns null if neither is set (the
 * settle flow and EIP-712 digest need this address; the UI must degrade to "not deployed here").
 */
const ADDR_ENV: Record<number, string | undefined> = {
  943: import.meta.env.VITE_PETITION_ADDR_943,
  369: import.meta.env.VITE_PETITION_ADDR_369,
}

export const petitionAddressFor = (chainId: number): Hex | null => {
  const fromEnv = ADDR_ENV[chainId]
  if (fromEnv) return fromEnv as Hex
  const dep = deployments[chainId]
  return dep ? dep.address : null
}

export interface ChainMeta {
  name: string
  symbol: string
  decimals: number
}

export const CHAINS: Record<number, ChainMeta> = {
  369: { name: 'PulseChain', symbol: 'PLS', decimals: 18 },
  943: { name: 'PulseChain v4', symbol: 'tPLS', decimals: 18 },
}

export const chainMeta = (chainId: number | null | undefined): ChainMeta =>
  (chainId != null && CHAINS[chainId]) || { name: `chain ${chainId ?? '?'}`, symbol: 'ETH', decimals: 18 }
