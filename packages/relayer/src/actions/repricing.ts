import type { RelayerAction, RelayerContext } from '../types.js'
import type { PendingTxTracker, TxFees } from '../stores/pending-tx.js'

/** What the caller's submit fn is handed: the nonce + fees to use, the item, and the runtime ctx. */
export type SubmitRequest<T> = {
  item: T
  nonce: number
  fees: TxFees
  context: RelayerContext
  /** True when this is a replace-by-fee resubmission of an already-pending nonce. */
  replacement: boolean
}

export type RepricingActionOptions<T> = {
  /** Tracks in-flight txs by nonce (window + RBF state). */
  tracker: PendingTxTracker
  /** Pure description for observe-mode logging. */
  describe: (item: T, context: RelayerContext) => string
  /** Build + send ONE tx at the given nonce/fees. Returns the tx hash. */
  submit: (req: SubmitRequest<T>) => Promise<{ hash: string }>
  /** Initial EIP-1559 fees for a fresh settlement (e.g. read from the chain). */
  initialFees: (item: T, context: RelayerContext) => Promise<TxFees>
  /** A pending tx older than this is replaced-by-fee. */
  staleMs: number
  /** Stable per-item key so a re-tick of the same settlement reuses its nonce. Defaults to JSON. */
  itemKey?: (item: T) => string
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Wraps a single-tx submit fn with a nonce window (pipeline multiple settlements)
 * and replace-by-fee (bump a stuck tx). Generic — the relayer spec §13 deferred
 * "nonce-window / repricing Action wrapper". Knows nothing about games.
 *
 * Safety: `describe` is pure (observe mode never submits). A submitted nonce is
 * remembered; a re-tick of the same item before it mines RBFs the SAME nonce
 * (never a second tx, never a forged state — it only re-sends the same calldata
 * at a higher fee). When the window is full a new item is a no-op this tick.
 */
export const repricingAction = <T>(options: RepricingActionOptions<T>): RelayerAction<T> => {
  const key = options.itemKey ?? ((item: T) => JSON.stringify(item))
  // item-key -> the nonce we assigned it, so a re-tick reuses it for RBF
  const nonceOf = new Map<string, number>()

  return {
    describe: (item, context) => options.describe(item, context),
    execute: async (item, context) => {
      const k = key(item)
      const existing = nonceOf.get(k)

      // Already in flight: replace-by-fee iff stale, else leave it.
      if (existing !== undefined) {
        if (!options.tracker.isStale(existing, options.staleMs)) {
          return { ok: true, ref: `nonce:${existing}`, meta: { skipped: 'still-pending' } }
        }
        const fees = options.tracker.bumpFees(existing)
        const { hash } = await options.submit({ item, nonce: existing, fees, context, replacement: true })
        options.tracker.recordSubmission(existing, { hash, ...fees })
        return { ok: true, ref: hash, meta: { replacement: true, nonce: existing } }
      }

      // New settlement: claim a nonce from the window.
      const nonce = options.tracker.claim()
      if (nonce === undefined) {
        return { ok: false, meta: { deferred: 'nonce-window-full' } }
      }
      const fees = await options.initialFees(item, context)
      const { hash } = await options.submit({ item, nonce, fees, context, replacement: false })
      nonceOf.set(k, nonce)
      options.tracker.recordSubmission(nonce, { hash, ...fees })
      return { ok: true, ref: hash, meta: { nonce } }
    },
  }
}
