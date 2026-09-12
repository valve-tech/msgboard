/// <reference lib="webworker" />

/**
 * Web-Worker PoW board worker.
 *
 * This is where the msgboard proof-of-work grind runs — NEVER on the main/render
 * thread (HARD RULE, memory-enforced; a main-thread grind freezes the render). The
 * window-less `DedicatedWorkerGlobalScope` here is the safe place for it. The worker:
 *   1. builds a read-only `MsgBoardClient` (used only to read the latest block during PoW),
 *   2. grinds the nonce for `{ category, data }`,
 *   3. posts the PoW'd message via `addMessage`,
 * reporting `progress` / `complete` / `error` back over `postMessage`.
 *
 * Ported from `packages/ui/src/service-worker/index.ts` (the live, functional Svelte
 * worker PoW pattern — the grind logic is identical) and reshaped into a dedicated
 * DedicatedWorker (cosign-web's `pow-worker.ts` shape), with two deliberate changes:
 *   - the global scope is a `DedicatedWorkerGlobalScope` + `ctx.postMessage` (not the old
 *     service-worker scope + `source.postMessage`), and
 *   - the chain is selected from `req.chainId` (the live Svelte worker hard-coded
 *     `pulsechainV4`); this generalization is what `transportUrl`-driven chain selection
 *     needs. The plan also folds `addMessage` INTO the worker (vs the Svelte split of a
 *     `doWork()` grind then a separate main-thread `send()`), so a single `work` request
 *     grinds AND posts the message — the user-visible outcome is identical.
 */

import * as msgboard from '@msgboard/sdk'
import initPowGrinder, { stamp as grinderStamp } from '@msgboard/pow-grinder/wasm'
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

/**
 * The fast WASM grinder (~1-2s/stamp vs tens of seconds for the JS grind), resolved once per
 * worker. Imported HERE — not via the SDK's dynamic cascade — so vite sees the module statically
 * and bundles pow_grinder_bg.wasm into this worker chunk. On any load failure the promise
 * resolves null and the SDK keeps its JS grind (`stamper: null`), so this can only be faster.
 */
const stamperPromise: Promise<msgboard.Stamper | null> = initPowGrinder()
  .then(() => msgboard.wrapEngineStamp(grinderStamp))
  .catch(() => null)

let boardClient: msgboard.MsgBoardClient | undefined

const post = (msg: WorkerResponseMsg) => ctx.postMessage(msg)

const doWork = async (req: StartWorkReq) => {
  const provider = createPublicClient({
    chain: chainFor(req.chainId),
    transport: http(req.rpc),
  }) as PublicClient

  boardClient = new msgboard.MsgBoardClient(provider as unknown as msgboard.Provider, {
    stamper: await stamperPromise,
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
    // ── grind (identical to the live Svelte worker's `doPoW` path) ──
    const result = await boardClient.doPoW(req.category, req.data)
    if (!result.stats.isValid) {
      post({ type: 'error', message: 'Failed to find a valid PoW message' })
      return
    }
    // Post the PoW'd message to the board (folded into the worker per the plan).
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
