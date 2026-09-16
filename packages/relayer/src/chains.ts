import type { Chain } from 'viem'
import { mainnet, pulsechain, pulsechainV4, sepolia } from 'viem/chains'

/**
 * The networks a relayer can target, keyed by chain id.
 *
 * Membership here means "the board on this chain serves msgboard", not merely
 * "viem knows the chain". Adding one is a deliberate act: an id absent from this
 * map makes every relayer against it throw on its first tick, which is how a
 * typo in a chain list fails loudly instead of indexing nothing in silence.
 */
const chainsById: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [pulsechain.id]: pulsechain,
  [pulsechainV4.id]: pulsechainV4,
  // Verified serving msgboard on 2026-09-08: msgboard_status returns enabled=true.
  [sepolia.id]: sepolia,
}

/**
 * Resolves a viem chain from its numeric id.
 * @throws if the chain id is not one of the supported networks
 */
export const resolveChain = (chainId: number): Chain => {
  const chain = chainsById[chainId]
  if (!chain) {
    const supported = Object.keys(chainsById).join(', ')
    throw new Error(`unsupported chainId ${chainId} (expected one of ${supported})`)
  }
  return chain
}
