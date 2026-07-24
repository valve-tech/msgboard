import type { Hex } from 'viem'
import type { ZkPost } from '../lib/zk-post'

/**
 * Wire protocol between the main thread (zk-prover seam) and the ZK Web Worker
 * (zk-worker.ts). Every request carries an `id` the seam uses to correlate the reply, so a
 * single long-lived worker can service many concurrent prove/verify calls.
 *
 * Secrets travel as decimal STRINGS (bigints are not structured-clone safe).
 */

// Main => Worker
export type ZkProveReq = {
  type: 'prove'
  id: number
  /** The local identity's two secrets (decimal strings). */
  identityNullifier: string
  identityTrapdoor: string
  /** The message payload to bind the proof to (hex of the chat text). */
  payload: Hex
  /** The epoch/scope string (the channel name), fed to `externalNullifier`. */
  scope: string
}
export type ZkVerifyReq = { type: 'verify'; id: number; post: ZkPost }
export type ZkWorkerRequest = ZkProveReq | ZkVerifyReq

// Worker => Main
export type ZkReadyMsg = { type: 'ready' }
export type ZkInitErrorMsg = { type: 'init-error'; message: string }
export type ZkProveOkMsg = { type: 'prove-ok'; id: number; post: ZkPost }
export type ZkProveErrMsg = { type: 'prove-err'; id: number; message: string }
export type ZkVerifyResMsg = { type: 'verify-res'; id: number; valid: boolean }
export type ZkWorkerResponse =
  | ZkReadyMsg
  | ZkInitErrorMsg
  | ZkProveOkMsg
  | ZkProveErrMsg
  | ZkVerifyResMsg
