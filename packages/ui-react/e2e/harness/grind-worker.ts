/// <reference lib="webworker" />

/**
 * E2E parity harness — REAL PoW grind worker.
 *
 * This runs the SAME `@msgboard/sdk` `doPoW` grind that the production worker
 * (`src/worker/pow-worker.ts`) runs — it is the real CPU work, not a fake/sleep — but
 * with two deliberate substitutions so it is runnable headlessly with no live board:
 *
 *   1. The provider is an in-worker STUB that answers only `eth_getBlockByNumber` with a
 *      fixed block. `doPoW` needs nothing else from the chain — the actual proof-of-work is
 *      pure crypto (`createChallengeSearch`), so the grind is 100% real. (`addMessage`, which
 *      would need a funded account + the `msgboard_` RPC module, is intentionally NOT called
 *      here; the production worker folds it in, but submitting on-chain is unreachable in CI.)
 *   2. Difficulty is driven LOW (large `workDivisor`) so a real grind completes in well under
 *      a second — fast enough for a deterministic test, but it is still a genuine grind loop.
 *
 * The whole point of this harness is the main-thread-responsiveness assertion the earlier
 * migration tasks deferred to Task 6: a real grind running HERE (in the worker) must NOT
 * freeze the page's main thread. The spec drives a main-thread heartbeat counter and asserts
 * it keeps ticking while this worker grinds.
 */
import * as msgboard from '@msgboard/sdk'
import type { Hex } from 'viem'

type StartMsg = {
  type: 'work'
  category: Hex
  data: Hex
  workMultiplier: string
  workDivisor: string
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

/** Stub provider: only `eth_getBlockByNumber` is needed by `doPoW`'s block poller. */
const stubProvider = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request<T, _U extends unknown[]>(arg: { method: string; params: unknown[] }): Promise<T> {
    if (arg.method === 'eth_getBlockByNumber') {
      return {
        hash: ('0x' + '11'.repeat(32)) as Hex,
        number: '0x1' as Hex,
      } as unknown as T
    }
    throw new Error(`stubProvider: unexpected method ${arg.method}`)
  },
}

ctx.addEventListener('message', (e: MessageEvent<StartMsg>) => {
  const msg = e.data
  if (msg.type !== 'work') return
  void runGrind(msg)
})

async function runGrind(msg: StartMsg) {
  const client = new msgboard.MsgBoardClient(stubProvider as unknown as msgboard.Provider, {
    difficultyFactors: {
      workMultiplier: BigInt(msg.workMultiplier),
      workDivisor: BigInt(msg.workDivisor),
    },
    breakInterval: 500n,
    progress: (stats) =>
      ctx.postMessage({
        type: 'progress',
        iterations: String(stats.iterations),
      }),
  })
  try {
    const result = await client.doPoW(msg.category, msg.data)
    ctx.postMessage({
      type: 'complete',
      isValid: result.stats.isValid,
      iterations: String(result.stats.iterations),
      duration: result.stats.duration,
    })
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
