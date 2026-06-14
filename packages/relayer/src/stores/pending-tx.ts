/** Fee fields for an EIP-1559 settle tx, in wei. */
export type TxFees = {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** What we retain about one in-flight tx, keyed by its nonce. */
export type PendingTx = {
  nonce: number
  hash: string
  fees: TxFees
  submittedAt: number
}

export type PendingTxTrackerOptions = {
  /** Max number of nonces in flight at once (the pipeline depth). */
  windowSize: number
  /** First nonce this worker owns (from `getTransactionCount(account, 'pending')`). */
  baseNonce: number
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
  /** RBF bump numerator/denominator. Defaults to 1125/1000 (+12.5%, above geth's 10% floor). */
  bumpNum?: bigint
  bumpDen?: bigint
}

/**
 * Tracks settle txs by nonce so multiple settlements pipeline (a bounded window)
 * and stuck ones can be replaced-by-fee. Knows nothing about games or settlement —
 * a generic engine primitive (the relayer spec §13 deferred item). Process-local.
 */
export type PendingTxTracker = {
  /** Reserve the next nonce, or undefined if the window is full. */
  claim(): number | undefined
  /** Record the tx hash + fees we submitted for a claimed nonce. */
  recordSubmission(nonce: number, tx: { hash: string } & TxFees): void
  /** True if the tx for `nonce` was submitted longer than `staleMs` ago and is still pending. */
  isStale(nonce: number, staleMs: number): boolean
  /** Compute strictly-higher fees for a replace-by-fee resubmission of `nonce`. */
  bumpFees(nonce: number): TxFees
  /** Mark a nonce's tx mined; frees the slot and advances the window. */
  markMined(nonce: number): void
  /** Current pending entries, for observability. */
  pending(): readonly PendingTx[]
}

const ceilMul = (v: bigint, num: bigint, den: bigint): bigint => (v * num + den - 1n) / den

export const createPendingTxTracker = (opts: PendingTxTrackerOptions): PendingTxTracker => {
  const now = opts.now ?? (() => Date.now())
  const bumpNum = opts.bumpNum ?? 1125n
  const bumpDen = opts.bumpDen ?? 1000n
  const inFlight = new Map<number, PendingTx | null>() // null = claimed, not yet submitted
  let nextNonce = opts.baseNonce

  const liveCount = (): number => inFlight.size

  return {
    claim: () => {
      if (liveCount() >= opts.windowSize) return undefined
      const nonce = nextNonce
      nextNonce += 1
      inFlight.set(nonce, null)
      return nonce
    },
    recordSubmission: (nonce, tx) => {
      inFlight.set(nonce, {
        nonce,
        hash: tx.hash,
        fees: { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
        submittedAt: now(),
      })
    },
    isStale: (nonce, staleMs) => {
      const e = inFlight.get(nonce)
      if (!e) return false
      return now() - e.submittedAt > staleMs
    },
    bumpFees: (nonce) => {
      const e = inFlight.get(nonce)
      if (!e) throw new Error(`pending-tx: no submission recorded for nonce ${nonce}`)
      return {
        maxFeePerGas: ceilMul(e.fees.maxFeePerGas, bumpNum, bumpDen),
        maxPriorityFeePerGas: ceilMul(e.fees.maxPriorityFeePerGas, bumpNum, bumpDen),
      }
    },
    markMined: (nonce) => {
      inFlight.delete(nonce)
    },
    pending: () => [...inFlight.values()].filter((e): e is PendingTx => e !== null),
  }
}
