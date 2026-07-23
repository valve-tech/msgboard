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

/** Just the slice of a viem client this module needs — keeps the helpers trivially testable. */
export interface GasPriceSource {
  getGasPrice(): Promise<bigint>
}

export interface LegacyFee {
  /** legacy type-0 fee per gas; pass straight to viem deployContract/writeContract `gasPrice`. */
  gasPrice: bigint
}

/**
 * Resolve a buffered legacy gas price from an already-fetched live price. Pure — no I/O.
 * `bufferBps` defaults to 2x (20000) so the tx clears any short-term price move; PulseChain gas is
 * so cheap in PLS terms that an over-buffer costs a rounding error. A `floorWei` guards the
 * degenerate case where a node briefly reports 0.
 */
export function bufferedLegacyFee(
  livePrice: bigint,
  opts: { bufferBps?: bigint; floorWei?: bigint } = {},
): LegacyFee {
  const bufferBps = opts.bufferBps ?? 20_000n // 2x
  const floorWei = opts.floorWei ?? 1_000_000_000n // 1 gwei floor
  if (livePrice < 0n) throw new Error('gas: live price must be non-negative')
  if (bufferBps < BPS) throw new Error('gas: bufferBps must be >= 10000 (no negative buffer)')
  const buffered = (livePrice * bufferBps) / BPS
  return { gasPrice: buffered > floorWei ? buffered : floorWei }
}

/** Fetch the live price and resolve a buffered legacy fee. The single entry point a script uses. */
export async function resolveLegacyFee(
  source: GasPriceSource,
  opts: { bufferBps?: bigint; floorWei?: bigint } = {},
): Promise<LegacyFee> {
  return bufferedLegacyFee(await source.getGasPrice(), opts)
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
