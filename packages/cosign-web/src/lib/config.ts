/**
 * Deployment-configurable endpoints + chain metadata for cosign-web. Every base URL here is a
 * const you can change in one place; nothing is hard-coded deeper in the app.
 */

/** JSON-RPC base for the SAFE's own chain — used for `eth_simulateV1` transaction simulation. */
export const SIM_RPC_BASE = 'https://one.valve.city/rpc/vk_demo/evm'

/** The simulation RPC for a given chain id (the Safe's chain, NOT the board chain). */
export const simRpcUrl = (chainId: number): string => `${SIM_RPC_BASE}/${chainId}`

/**
 * The cosign archivist read API (long-tail shares that have aged out of the live board). The union
 * of board ∪ archive keeps expired shares counting toward the quorum. Degrades to board-only if down.
 */
export const ARCHIVE_BASE = 'https://cosign-archive.msgboard.xyz'

/**
 * The self-hosted Safe-owner indexer (owner → safes) for chains WITHOUT an official Safe Tx Service
 * (PulseChain 369 / v4 943). Same response shape as the Safe Tx Service (`{ safes: [...] }`).
 * Change this to `https://safe-indexer.msgboard.xyz` if the dedicated host is used instead of the
 * cosign-host path route.
 */
export const SAFE_INDEXER_BASE = 'https://cosign.msgboard.xyz/safe-indexer'

/**
 * Official Safe Transaction Service bases, keyed by chain id. Only chains listed here use the real
 * upstream service for discovery; everything else falls back to the self-hosted indexer.
 */
export const SAFE_TX_SERVICE: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
}

/** Display metadata for the chains cosign-web knows about. */
export interface ChainMeta {
  name: string
  symbol: string
  decimals: number
}

export const CHAINS: Record<number, ChainMeta> = {
  1: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  369: { name: 'PulseChain', symbol: 'PLS', decimals: 18 },
  943: { name: 'PulseChain v4', symbol: 'tPLS', decimals: 18 },
}

export const chainMeta = (chainId: number | null | undefined): ChainMeta =>
  (chainId != null && CHAINS[chainId]) || { name: `chain ${chainId ?? '?'}`, symbol: 'ETH', decimals: 18 }
