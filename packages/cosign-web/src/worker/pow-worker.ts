/// <reference lib="webworker" />

/**
 * Web-Worker PoW board worker.
 *
 * This is where the msgboard proof-of-work grind runs — NEVER on the main/render thread
 * (HARD RULE; a main-thread grind freezes the render for ~1-2s). The window-less
 * `DedicatedWorkerGlobalScope` here is the safe place for it. The worker:
 *   1. builds a read-only `MsgBoardClient` (used only to read the latest block during PoW),
 *   2. grinds the nonce for `{ category, data }`,
 *   3. posts the PoW'd message via `addMessage`,
 * reporting `progress` / `complete` / `error` back over `postMessage`.
 *
 * Adopted verbatim from packages/ui's `pow-worker.ts`.
 */

import * as msgboard from '@msgboard/sdk'
import { createPublicClient, http, type PublicClient } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import type { StartWorkReq, WorkerRequestMsg, WorkerResponseMsg } from './types'

export type * from './types'

const ctx = self as unknown as DedicatedWorkerGlobalScope

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

let boardClient: msgboard.MsgBoardClient | undefined

const post = (msg: WorkerResponseMsg) => ctx.postMessage(msg)

const doWork = async (req: StartWorkReq) => {
  const provider = createPublicClient({
    chain: chainFor(req.chainId),
    transport: http(req.rpc),
  }) as PublicClient

  boardClient = new msgboard.MsgBoardClient(provider as unknown as msgboard.Provider, {
    difficultyFactors: {
      workMultiplier: BigInt(req.workMultiplier),
      workDivisor: BigInt(req.workDivisor),
    },
    breakInterval: 10_000n, // break every 10k iterations
    logger: (_format, method: string, ..._params: unknown[]) => {
      if (
        typeof method !== 'string' ||
        (!method.startsWith('eth_') && !method.startsWith('msgboard_'))
      ) {
        return
      }
      post({ type: 'log', message: method })
    },
    progress: (stats) => post({ type: 'progress', stats }),
  })

  try {
    const result = await boardClient.doPoW(req.category, req.data)
    if (!result.stats.isValid) {
      post({ type: 'error', message: 'Failed to find a valid PoW message' })
      return
    }
    await boardClient.addMessage(result.message)
    post({ type: 'complete', result })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : 'Unknown error during PoW' })
  }
}

ctx.addEventListener('message', (e: MessageEvent<WorkerRequestMsg>) => {
  const msg = e.data
  switch (msg.type) {
    case 'cancel':
      boardClient?.cancel()
      break
    case 'work':
      void doWork(msg)
      break
    default:
      break
  }
})
