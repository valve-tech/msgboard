import { createPublicClient, http, type Hex, type PublicClient } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import * as msgboard from '@msgboard/sdk'
import type { Content } from '@msgboard/sdk'
import type { BoardClient } from '@msgboard/cosign'
import type { ProgressMsg, WorkerRequestMsg, WorkerResponseMsg } from '../worker/types'

export type { BoardClient }

export interface WorkerBoardOptions {
  /** RPC endpoint that serves the `msgboard_` module (read + the worker's block reads). */
  rpc: string
  /** Chain id of the board chain (1 | 369 | 943). */
  chainId: number
  workMultiplier: number
  workDivisor: number
  /** Optional progress callback (drives the UI's "grinding…" indicator). */
  onProgress?: (msg: ProgressMsg) => void
  /** Worker factory — injectable so headless tests can substitute a fake `Worker`. */
  workerFactory?: () => Worker
}

const chainFor = (chainId: number) => {
  switch (chainId) {
    case mainnet.id:
      return mainnet
    case pulsechain.id:
      return pulsechain
    case pulsechainV4.id:
      return pulsechainV4
    default:
      return pulsechainV4
  }
}

const defaultWorkerFactory = (): Worker =>
  new Worker(new URL('../worker/pow-worker.ts', import.meta.url), { type: 'module' })

/**
 * Main-thread `BoardClient` (the cosign seam) that drives the Web-Worker PoW grind.
 *
 * - `addMessage` posts `{ type: 'work', ... }` to the worker and resolves on `complete`
 *   (rejects on `error`). The grind itself runs in the worker — NEVER on the main thread.
 * - `content` reads via a read-only `MsgBoardClient` on the main thread (no PoW involved).
 *
 * One worker is spawned per `addMessage` so a grind can be torn down cleanly; the read
 * client is reused. Adopted verbatim from packages/ui's `makeWorkerBoard`.
 */
export function makeWorkerBoard(opts: WorkerBoardOptions): BoardClient {
  const provider = createPublicClient({
    chain: chainFor(opts.chainId),
    transport: http(opts.rpc),
  }) as PublicClient
  const readClient = new msgboard.MsgBoardClient(provider as unknown as msgboard.Provider)

  return {
    addMessage({ category, data }: { category: Hex; data: Hex }): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const worker = (opts.workerFactory ?? defaultWorkerFactory)()
        const cleanup = () => {
          worker.removeEventListener('message', onMessage)
          worker.terminate()
        }
        const onMessage = (e: MessageEvent<WorkerResponseMsg>) => {
          const msg = e.data
          switch (msg.type) {
            case 'progress':
              opts.onProgress?.(msg)
              break
            case 'complete':
              cleanup()
              resolve(msg.result)
              break
            case 'error':
              cleanup()
              reject({ kind: 'pow', message: msg.message })
              break
            case 'log':
            default:
              break
          }
        }
        worker.addEventListener('message', onMessage)
        worker.addEventListener('error', (err: ErrorEvent) => {
          cleanup()
          reject({ kind: 'pow', message: err.message || 'PoW worker crashed' })
        })
        const req: WorkerRequestMsg = {
          type: 'work',
          rpc: opts.rpc,
          chainId: opts.chainId,
          category,
          data,
          workMultiplier: String(opts.workMultiplier),
          workDivisor: String(opts.workDivisor),
        }
        worker.postMessage(req)
      })
    },
    async content({ category }: { category: Hex }): Promise<Content> {
      return readClient.content({ category })
    },
  }
}
