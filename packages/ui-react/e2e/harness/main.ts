import type { Hex } from 'viem'

/**
 * E2E parity harness — main-thread driver for the real-grind responsiveness test.
 *
 * Exposes `window.__powHarness` so the Playwright spec can:
 *   - start a REAL PoW grind in a Web Worker (`grind-worker.ts`),
 *   - read a main-thread heartbeat counter that ticks on `setInterval` — if the grind ever
 *     ran on the main thread, the heartbeat would FREEZE; the spec asserts it keeps ticking
 *     while the worker reports progress and until it completes.
 *
 * This is the authoritative "main thread stays responsive during a REAL grind" assertion
 * that Tasks 2–5 deferred here (Task 6).
 */
declare global {
  interface Window {
    __powHarness: {
      heartbeat: () => number
      start: (opts?: { workMultiplier?: string; workDivisor?: string }) => void
      progressCount: () => number
      result: () => {
        isValid: boolean
        iterations: string
        duration: number
      } | null
      error: () => string | null
    }
  }
}

let heartbeat = 0
// A main-thread heartbeat. Pure JS timer — only advances if the main thread's event loop
// is free to run it. A main-thread grind would starve this; an off-thread grind cannot.
setInterval(() => {
  heartbeat += 1
}, 10)

let progressCount = 0
let result: { isValid: boolean; iterations: string; duration: number } | null = null
let error: string | null = null

window.__powHarness = {
  heartbeat: () => heartbeat,
  progressCount: () => progressCount,
  result: () => result,
  error: () => error,
  start: (opts) => {
    progressCount = 0
    result = null
    error = null
    const worker = new Worker(new URL('./grind-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener(
      'message',
      (e: MessageEvent<{ type: string; [k: string]: unknown }>) => {
        const msg = e.data
        if (msg.type === 'progress') progressCount += 1
        else if (msg.type === 'complete') {
          result = {
            isValid: msg.isValid as boolean,
            iterations: msg.iterations as string,
            duration: msg.duration as number,
          }
          worker.terminate()
        } else if (msg.type === 'error') {
          error = msg.message as string
          worker.terminate()
        }
      },
    )
    worker.postMessage({
      type: 'work',
      category: ('0x' + '33'.repeat(32)) as Hex,
      data: '0xdeadbeef' as Hex,
      // Default to a LOW (but non-zero) difficulty so a real grind finishes fast while still
      // being a genuine multi-thousand-iteration grind that crosses the worker's breakInterval.
      // difficulty = (2^24 + dataLen*10_000) * mult / div  (it's the win MODULUS; smaller = easier).
      // For 4-byte data: (16_777_216 + 40_000)/4000 ≈ 4204 → a few thousand iterations, sub-second.
      workMultiplier: opts?.workMultiplier ?? '1',
      workDivisor: opts?.workDivisor ?? '4000',
    })
  },
}

// Signal the page is wired up.
document.body.setAttribute('data-harness-ready', 'true')
