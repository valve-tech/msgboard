import type { Hex } from 'viem'
import type { Settlement } from '@msgboard/settle'

/**
 * A session the worker has been GIVEN or watches: the retained transcript JSON plus
 * the metadata needed to settle it. The worker never owns the play state — a party
 * (or the house) hands it the transcript it already holds (spec §2 retention rule).
 */
export interface SettleReadySession {
  /** bytes32 table/session id. */
  tableId: Hex
  /** Retained transcript JSON (Transcript.toJSON()). */
  transcriptJson: string
  /** The backend that builds this session's settle calldata (optimistic or escrowed). */
  settlement: Settlement
  /** Why this is settle-ready: cooperative final, batch threshold, or player closing out. */
  trigger: 'cooperative-final' | 'batch-threshold' | 'player-closeout'
  /** Wall-clock ms when the latest co-signed state was observed (for nudge staleness). */
  observedAt: number
  /** Optional: the player address awaiting a signature/gas, for nudges. */
  player?: Hex
}

/** One settlement job flowing through the relayer pipeline. Carries the built calldata lazily. */
export interface SettleJob {
  session: SettleReadySession
}

/** A reminder surfaced to the UI. The worker NEVER acts on these — it only emits them. */
export interface Nudge {
  tableId: Hex
  kind: 'sign-next-state' | 'top-up-gas'
  /** Who the nudge is for. */
  target?: Hex
  /** Human-readable, shown inline in the UI (spec §8). */
  message: string
}

/** How a deployer parameterizes the worker. */
export interface WorkerConfig {
  /** A pending-state-stall threshold (ms) past which a sign-next-state nudge fires. */
  signStaleMs: number
  /** Minimum gas balance (wei) below which a top-up-gas nudge fires. */
  minGasWei: bigint
  /** Pipeline depth: how many settlements may be in flight at once. */
  windowSize: number
  /** RBF staleness threshold (ms) for a stuck settle tx. */
  rbfStaleMs: number
}
