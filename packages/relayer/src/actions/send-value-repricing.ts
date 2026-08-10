import {
  type Account,
  type Address,
  type WalletClient,
  createWalletClient,
  formatEther,
} from 'viem'
import type { RelayerAction, RelayerContext } from '../types.js'
import type { TxFees } from '../stores/pending-tx.js'
import { estimateFees, type FeeEstimateOptions } from '../fees.js'

const ceilMul = (v: bigint, num: bigint, den: bigint): bigint => (v * num + den - 1n) / den
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b)

export type SendValueRepricingActionOptions<T> = {
  /** The funding account (e.g. from `mnemonicToAccount`). */
  account: Account
  /** Derives the recipient address for an item. */
  recipient: (item: T, context: RelayerContext) => Address
  /** Amount to send, in wei. */
  amount: bigint
  /** Gas limit for the transfer. */
  gas: bigint
  /** Dynamic fee-estimation knobs (baseFee-derived; never `eth_gasPrice`). */
  fee?: FeeEstimateOptions
  /** Wait this long for a receipt before repricing (replace-by-fee). Default 20s. */
  staleMs?: number
  /** Max reprice attempts before giving up (throws → not remembered → retried next tick). Default 6. */
  maxAttempts?: number
  /** RBF bump numerator/denominator. Default 1125/1000 (+12.5%, above geth's 10% floor). */
  bumpNum?: bigint
  bumpDen?: bigint
  /** Overridable wallet-client factory (injected in tests). */
  walletFactory?: (context: RelayerContext) => WalletClient
}

/**
 * Sends native coin with a DYNAMIC fee + reprice-and-replace loop, all inside one
 * `execute()` so it fits the engine's execute-once-then-dedup model (no mined-aware
 * store needed). Estimates fees from the real base fee, submits at a fixed nonce,
 * and if the tx hasn't mined within `staleMs` it re-estimates, bumps +12.5% over the
 * previous fee, and RESUBMITS THE SAME NONCE (replace-by-fee) — so a tx can never
 * wedge the account the way an unpriced fire-and-forget send does. Returns once the
 * nonce is mined; throws if it can't land within `maxAttempts` (so the engine leaves
 * it un-remembered and retries next tick).
 *
 * Purpose-built for PulseChain 943/369, where trusting the node's gas quote is the
 * whole bug (see fees.ts).
 */
export const sendValueRepricingAction = <T>(
  options: SendValueRepricingActionOptions<T>,
): RelayerAction<T> => {
  const staleMs = options.staleMs ?? 20_000
  const maxAttempts = options.maxAttempts ?? 6
  const bumpNum = options.bumpNum ?? 1125n
  const bumpDen = options.bumpDen ?? 1000n
  const makeWallet = (context: RelayerContext): WalletClient =>
    options.walletFactory?.(context) ??
    createWalletClient({
      account: options.account,
      chain: context.chain,
      transport: context.node.transport,
    })

  return {
    describe: (item, context) =>
      `send ${formatEther(options.amount)} to ${options.recipient(item, context)} (dynamic-fee+RBF)`,
    execute: async (item, context) => {
      const wallet = makeWallet(context)
      const to = options.recipient(item, context)
      const address = options.account.address
      const nonce = await context.publicClient.getTransactionCount({ address, blockTag: 'pending' })

      let fees: TxFees = await estimateFees(context.publicClient, options.fee)
      let lastHash: `0x${string}` | undefined

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Did a prior attempt (or the original) already mine this nonce? Then we're done.
        const confirmed = await context.publicClient.getTransactionCount({ address, blockTag: 'latest' })
        if (confirmed > nonce) return { ok: true, ref: lastHash ?? `nonce:${nonce}` }

        // On a reprice, take the higher of (bumped previous fee) and (fresh chain estimate):
        // dynamic AND monotonic, so RBF always strictly exceeds the stuck tx.
        if (attempt > 0) {
          const fresh = await estimateFees(context.publicClient, options.fee)
          fees = {
            maxFeePerGas: maxBig(ceilMul(fees.maxFeePerGas, bumpNum, bumpDen), fresh.maxFeePerGas),
            maxPriorityFeePerGas: maxBig(
              ceilMul(fees.maxPriorityFeePerGas, bumpNum, bumpDen),
              fresh.maxPriorityFeePerGas,
            ),
          }
        }

        try {
          lastHash = await wallet.sendTransaction({
            account: options.account,
            chain: context.chain,
            to,
            value: options.amount,
            gas: options.gas,
            nonce,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          })
        } catch (error) {
          const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
          // The prior submission for this nonce mined or is still winning — re-check next loop.
          if (
            msg.includes('nonce too low') ||
            msg.includes('already known') ||
            msg.includes('replacement transaction underpriced')
          ) {
            continue
          }
          throw error
        }

        try {
          await context.publicClient.waitForTransactionReceipt({ hash: lastHash, timeout: staleMs })
          return { ok: true, ref: lastHash }
        } catch {
          // Receipt timeout → reprice + replace-by-fee on the next iteration.
          continue
        }
      }

      throw new Error(
        `sendValueRepricing: nonce ${nonce} not mined after ${maxAttempts} reprice attempts`,
      )
    },
  }
}
