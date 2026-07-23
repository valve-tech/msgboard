import type { Hex } from 'viem'
import type { TxRequest } from '@msgboard/settle'
import {
  type RelayerAction,
  type RelayerContext,
  repricingAction,
  type PendingTxTracker,
  type TxFees,
} from '@msgboard/relayer'
import type { SettleJob } from './types'

/** What a submitter is handed: the viem-ready TxRequest plus the nonce/fees the engine chose. */
export interface SettleSubmitRequest {
  tx: TxRequest
  nonce: number
  fees: TxFees
  replacement: boolean
  context: RelayerContext
}

export interface SettleActionOptions {
  /** Nonce-window + RBF state, shared across this worker's jobs. */
  tracker: PendingTxTracker
  /** Build + send ONE settle tx (production: simulate -> writeContract). Returns the hash. */
  submitTx: (req: SettleSubmitRequest) => Promise<{ hash: Hex }>
  /** Initial EIP-1559 fees for a fresh settle tx. */
  initialFees: (job: SettleJob, context: RelayerContext) => Promise<TxFees>
  /** RBF staleness threshold (ms). */
  staleMs: number
}

/**
 * The games-aware settle action: per job, build the settle calldata from the retained
 * transcript (OptimisticSettlement / EscrowedSettlement.buildSettle, which re-verifies
 * every signature and THROWS on any tamper), then submit it via the injected submitter,
 * wrapped by the engine's repricingAction for the nonce window + replace-by-fee.
 *
 * Safety: the action never builds a SessionState, never signs, never mutates a transcript.
 * buildSettle's throw on a bad transcript becomes ok:false with nothing submitted — the
 * worker's only power is WHEN a valid, fully-signed settlement lands, never WHAT it says.
 */
export const makeSettleAction = (options: SettleActionOptions): RelayerAction<SettleJob> => {
  const inner = repricingAction<SettleJob>({
    tracker: options.tracker,
    itemKey: (job) => job.session.tableId, // one nonce per session, so RBF re-sends the same settle
    describe: (job) => `settle session ${job.session.tableId.slice(0, 6)}… (${job.session.trigger})`,
    initialFees: options.initialFees,
    staleMs: options.staleMs,
    submit: async ({ item, nonce, fees, context, replacement }) => {
      // buildSettle re-verifies the retained transcript; it throws on any chain/sig/outcome mismatch.
      let tx: TxRequest
      try {
        tx = await item.session.settlement.buildSettle(item.session.transcriptJson)
      } catch (err) {
        // a tampered/un-ready transcript: refuse, do not submit (safety invariant)
        throw new Error(`settle: refused to build calldata: ${err instanceof Error ? err.message : err}`)
      }
      const { hash } = await options.submitTx({ tx, nonce, fees, replacement, context })
      return { hash }
    },
  })

  // Wrap so a build-throw (tampered/un-ready transcript) surfaces as ok:false with nothing
  // submitted, AND the Relayer still isolates it cleanly in live mode.
  return {
    describe: inner.describe,
    execute: async (item, ctx) => {
      try {
        return await inner.execute(item, ctx)
      } catch {
        return { ok: false, meta: { refused: 'invalid-transcript' } }
      }
    },
  }
}
