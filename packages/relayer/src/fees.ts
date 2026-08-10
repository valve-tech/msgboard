import type { PublicClient } from 'viem'
import type { TxFees } from './stores/pending-tx.js'

const GWEI = 1_000_000_000n

export type FeeEstimateOptions = {
  /**
   * Minimum priority tip (wei) — the fee that actually clears validators. REQUIRED
   * as a floor because chains like PulseChain (943/369) report a near-zero baseFee
   * yet quote an absurd ~100k+ gwei `eth_gasPrice`; the honest clearing price is a
   * few gwei, so we derive from baseFee + this floor and never touch `eth_gasPrice`.
   * Default 2 gwei (943 confirmed txs mine at ~0.03–5 gwei; median ~1).
   */
  priorityFloor?: bigint
  /** maxFeePerGas = baseFee * baseMultiplier + priority. Default 2 (covers a base-fee spike). */
  baseMultiplier?: bigint
}

/**
 * Dynamic EIP-1559 fees read from the chain's REAL base fee — deliberately NOT the
 * node's `eth_gasPrice`/`maxPriorityFeePerGas` suggestion, which on PulseChain is
 * junk (~100k gwei) and, if trusted, makes txs stick (underpriced) or overpay wildly.
 * Repricing/RBF (see sendValueRepricingAction) bumps upward from this baseline.
 */
export const estimateFees = async (
  publicClient: PublicClient,
  opts: FeeEstimateOptions = {},
): Promise<TxFees> => {
  const priorityFloor = opts.priorityFloor ?? 2n * GWEI
  const baseMultiplier = opts.baseMultiplier ?? 2n
  const block = await publicClient.getBlock({ blockTag: 'latest' })
  const baseFee = block.baseFeePerGas ?? 0n
  const maxPriorityFeePerGas = priorityFloor
  const maxFeePerGas = baseFee * baseMultiplier + maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas }
}
