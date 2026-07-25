/**
 * PulseChain-safe gas resolution.
 *
 * WHY THIS EXISTS: PulseChain (mainnet 369 and testnet v4 943) reports a normal-looking
 * `eth_gasPrice` (~5 gwei) but a near-zero `baseFeePerGas` (~7 wei). EIP-1559 fee estimation —
 * which viem and hardhat do by DEFAULT — derives `maxFeePerGas` from that tiny base fee and is
 * unreliable on this chain: the "given values will not work". The robust fix is to send LEGACY
 * (type-0) transactions with an explicit `gasPrice` taken from the live chain and buffered, so the
 * transaction is always priced well above base and gets mined regardless of the 1559 quirks.
 *
 * Nothing here is hardcoded to a chain: the price is always read live and buffered. The helpers are
 * pure (take the already-fetched live price) so they can be unit-tested against the exact
 * PulseChain shape without a node.
 */

const BPS = 10_000n

/**
 * Just the slice of a viem client this module needs — the latest block's base fee.
 *
 * CRITICAL: we do NOT use `eth_gasPrice` / `eth_maxPriorityFeePerGas` on PulseChain. Those endpoints
 * return an absurd ~100,000 gwei suggestion (measured on 943), while the real `baseFeePerGas` is ~7
 * wei and blocks are empty — so trusting the suggestion overpays gas by ~5–6 orders of magnitude (a
 * simple deploy "cost" 172 PLS at the suggested price vs ~0.0004 PLS at base fee + a tip). We MATCH
 * THE BASE FEE and add a tiny fixed tip that reliably mines.
 */
export interface FeeSource {
  getBlock(args?: { blockTag?: 'latest' | 'pending' }): Promise<{ baseFeePerGas: bigint | null }>
}

export interface LegacyFee {
  /** legacy type-0 fee per gas; pass straight to viem deployContract/writeContract `gasPrice`. */
  gasPrice: bigint
}

const DEFAULT_TIP_WEI = 500_000_000n // 0.5 gwei — above the ~0.1 gwei that mines on 943, negligible in PLS

/**
 * Pure: legacy gasPrice = base fee + a small priority tip. No I/O. The tip (default 0.5 gwei) is what
 * gets the tx included on an otherwise-empty chain; the base fee tracks the live floor so the price is
 * always >= base. `tipWei` overrides the tip; a `floorWei` guards a node briefly reporting no base fee.
 */
export function baseFeeLegacyFee(
  baseFee: bigint,
  opts: { tipWei?: bigint; floorWei?: bigint; bufferBps?: bigint } = {}, // bufferBps accepted for back-compat, ignored
): LegacyFee {
  const tip = opts.tipWei ?? DEFAULT_TIP_WEI
  const floorWei = opts.floorWei ?? DEFAULT_TIP_WEI
  if (baseFee < 0n) throw new Error('gas: base fee must be non-negative')
  if (tip < 0n) throw new Error('gas: tip must be non-negative')
  const price = baseFee + tip
  return { gasPrice: price > floorWei ? price : floorWei }
}

/** Fetch the live base fee and resolve a base-fee-matched legacy fee. The entry point a script uses. */
export async function resolveLegacyFee(
  source: FeeSource,
  opts: { tipWei?: bigint; floorWei?: bigint; bufferBps?: bigint } = {}, // bufferBps accepted for back-compat, ignored
): Promise<LegacyFee> {
  const block = await source.getBlock({ blockTag: 'latest' })
  return baseFeeLegacyFee(block.baseFeePerGas ?? 0n, opts)
}

/**
 * Buffer a gas-LIMIT estimate. `eth_estimateGas` can land slightly low for some ops; we pad it and
 * cap below the block gas limit so a pad can never produce an un-mineable limit. Pure.
 */
export function bufferedGasLimit(
  estimate: bigint,
  opts: { bufferBps?: bigint; capWei?: bigint } = {},
): bigint {
  const bufferBps = opts.bufferBps ?? 13_000n // 1.3x
  const cap = opts.capWei ?? 29_000_000n // under the 30M block limit
  if (estimate <= 0n) throw new Error('gas: estimate must be positive')
  if (bufferBps < BPS) throw new Error('gas: bufferBps must be >= 10000')
  const buffered = (estimate * bufferBps) / BPS
  return buffered > cap ? cap : buffered
}
