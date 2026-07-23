import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Hex,
  type WalletClient,
} from 'viem'
import {
  Relayer,
  type RelayerMode,
  type RelayerNode,
  createPendingTxTracker,
  type PendingTxTracker,
  type TxFees,
} from '@msgboard/relayer'
import { settleReadySource } from './settleReadySource'
import { makeSettleAction, type SettleSubmitRequest } from './settleAction'
import type { SettleJob, SettleReadySession, WorkerConfig } from './types'

export interface SettlementRelayerOptions {
  node: RelayerNode
  /** Defaults to 'observe' (engine default) — lands nothing until set to 'live'. */
  mode?: RelayerMode
  /** Reports settle-ready sessions each tick (watcher / close-out queue). */
  provider: () => Promise<readonly SettleReadySession[]>
  /** Build + send one settle tx. Defaults to the viem simulate->write submitter when `account` given. */
  submitTx?: (req: SettleSubmitRequest) => Promise<{ hash: Hex }>
  /** Funding account for the default viem submitter (ignored if `submitTx` supplied). */
  account?: Account
  /** Initial EIP-1559 fees for a fresh settle tx. */
  initialFees: (job: SettleJob, context: unknown) => Promise<TxFees>
  config: WorkerConfig
  /** Injectable clock (tests). */
  now?: () => number
  /** First nonce; defaults to 0 (production reads getTransactionCount before start). */
  baseNonce?: number
  /** Override the tracker (tests). */
  tracker?: PendingTxTracker
}

/**
 * The default production submitter: viem simulate -> writeContract at the engine-chosen
 * nonce + fees (the @msgboard/games-core operator.ts pattern, spec §6 / Plan 2). RBF resubmits
 * reuse the same nonce, so a replacement overrides the stuck tx.
 */
const viemSubmitter =
  (account: Account) =>
  async (req: SettleSubmitRequest): Promise<{ hash: Hex }> => {
    const { tx, nonce, fees, context } = req
    const ctx = context as { publicClient: ReturnType<typeof createPublicClient>; chain: any; node: RelayerNode }
    const wallet: WalletClient = createWalletClient({
      account,
      chain: ctx.chain,
      transport: ctx.node.transport,
    })
    const { request } = await ctx.publicClient.simulateContract({
      account,
      address: tx.address,
      abi: tx.abi as any,
      functionName: tx.functionName,
      args: tx.args as any,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    const hash = await wallet.writeContract(request)
    return { hash }
  }

/** Assemble the async settlement worker as a Relayer<SettleJob>. Untrusted, anyone-can-run. */
export const makeSettlementRelayer = (options: SettlementRelayerOptions): Relayer<SettleJob> => {
  const tracker =
    options.tracker ??
    createPendingTxTracker({
      windowSize: options.config.windowSize,
      baseNonce: options.baseNonce ?? 0,
      now: options.now,
    })

  const submitTx =
    options.submitTx ??
    (() => {
      if (!options.account) throw new Error('worker: pass either submitTx or account')
      return viemSubmitter(options.account)
    })()

  const action = makeSettleAction({
    tracker,
    submitTx,
    initialFees: (job, ctx) => options.initialFees(job, ctx),
    staleMs: options.config.rbfStaleMs,
  })

  return new Relayer<SettleJob>({
    node: options.node,
    mode: options.mode ?? 'observe',
    source: settleReadySource({ provider: options.provider }),
    action,
    key: (job) => job.session.tableId,
  })
}
