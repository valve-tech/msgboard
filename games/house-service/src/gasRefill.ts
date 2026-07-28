/**
 * gasRefill.ts — keep a funded actor key topped up with native gas from a funder wallet (account 0).
 *
 * Mirrors the fleet's existing top-up pattern (cast-watcher `topUpOps`, player-bots `topUp`): when the
 * target's balance dips below `below`, send it back up to `to`. Split into a PURE `computeTopUp` (the
 * arithmetic, trivially testable) and a thin `refuelGas` (the balance read + funded send, with explicit
 * EIP-1559 fees — required on PulseChain, where an unpriced tx underprices to ~16 wei and never mines).
 */
import { parseGwei, type Account, type Address, type Hex } from 'viem'

/** Amount to send to bring `balance` up to `to`, or 0n if already at/above `below`. Never negative. */
export function computeTopUp(balance: bigint, opts: { below: bigint; to: bigint }): bigint {
  if (balance >= opts.below) return 0n
  return opts.to > balance ? opts.to - balance : 0n
}

/** Minimal viem surfaces so the helper is unit-testable without a live chain. */
export interface RefuelPublicClient {
  getBalance(args: { address: Address }): Promise<bigint>
}
export interface RefuelWalletClient {
  sendTransaction(args: {
    account: Account
    to: Address
    value: bigint
    chain?: unknown
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }): Promise<Hex>
}

export interface RefuelGasOpts {
  publicClient: RefuelPublicClient
  walletClient: RefuelWalletClient
  /** The funder (e.g. account 0). */
  funder: Account
  /** The key to keep topped up (e.g. the faucet key at idx 51). */
  target: Address
  /** Top up when the target's balance is strictly below this (wei). */
  below: bigint
  /** Top the target back up to this balance (wei). */
  to: bigint
  chain?: unknown
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

/**
 * Read the target's balance and, if below `below`, send `to - balance` from `funder`. Returns the amount
 * sent (0n if no top-up needed) and the tx hash if one was sent. Fees default to PulseChain-sane values.
 */
export async function refuelGas(opts: RefuelGasOpts): Promise<{ topUp: bigint; hash?: Hex }> {
  const balance = await opts.publicClient.getBalance({ address: opts.target })
  const topUp = computeTopUp(balance, { below: opts.below, to: opts.to })
  if (topUp === 0n) return { topUp: 0n }
  const hash = await opts.walletClient.sendTransaction({
    account: opts.funder,
    to: opts.target,
    value: topUp,
    chain: opts.chain,
    maxFeePerGas: opts.maxFeePerGas ?? parseGwei('2'),
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? parseGwei('0.5'),
  })
  return { topUp, hash }
}
