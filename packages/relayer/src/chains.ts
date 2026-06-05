import type { Chain } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'

/** The networks a relayer can target, keyed by chain id. */
const chainsById: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [pulsechain.id]: pulsechain,
  [pulsechainV4.id]: pulsechainV4,
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
