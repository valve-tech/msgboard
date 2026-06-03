import type { WorkStats, WorkResult } from '@msgboard/sdk'

/** Messages from the main thread to the service worker. */
export type WorkerRequestMsg = StartWorkReq | CancelReq
/** Messages from the service worker to the main thread. */
export type WorkerResponseMsg = LogMsg | ProgressMsg | CompleteMsg | ErrorMsg

// Main => Worker
export type CancelReq = { type: 'cancel' }
export type StartWorkReq = {
  type: 'work'
  rpc: string
  data: string
  category: string
  workMultiplier: string
  workDivisor: string
}

// Worker => Main
export type LogMsg = { type: 'log'; message: string }
export type ProgressMsg = { type: 'progress'; stats: WorkStats }
export type CompleteMsg = { type: 'complete'; result: WorkResult }
export type ErrorMsg = { type: 'error'; message: string }
