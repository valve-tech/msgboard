import type { WorkStats, WorkResult } from '@msgboard/sdk'

/** Messages from the main thread to the PoW worker. */
export type WorkerRequestMsg = StartWorkReq | CancelReq
/** Messages from the PoW worker back to the main thread. */
export type WorkerResponseMsg = LogMsg | ProgressMsg | CompleteMsg | ErrorMsg

// Main => Worker
export type CancelReq = { type: 'cancel' }
export type StartWorkReq = {
  type: 'work'
  /** RPC endpoint the worker's read-only `MsgBoardClient` uses to fetch the latest block during PoW. */
  rpc: string
  /**
   * Chain id for the worker's public client (1 | 369 | 943).
   *
   * Generalized from the live Svelte worker, which hard-coded `pulsechainV4`. The
   * `transportUrl`-driven chain selection passes `chain.chain?.id` so the worker grinds
   * against whichever chain the user selected (default 943).
   */
  chainId: number
  /** The message bytes to post (hex). */
  data: string
  /** The rotating board category (hex). */
  category: string
  /** Difficulty factors (stringified bigints for structured-clone safety). */
  workMultiplier: string
  workDivisor: string
}

// Worker => Main
export type LogMsg = { type: 'log'; message: string }
export type ProgressMsg = { type: 'progress'; stats: WorkStats }
export type CompleteMsg = { type: 'complete'; result: WorkResult }
export type ErrorMsg = { type: 'error'; message: string }
