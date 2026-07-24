import { parentPort } from 'node:worker_threads'
import { initSync, stamp as wasmStamp } from '@msgboard/pow-grinder/wasm'
import { POW_GRINDER_WASM_B64 } from './pow-grinder-wasm-b64'

/**
 * Node worker_threads grinder — a PURE STAMPER. It mints the MsgBoard proof-of-work stamp (the heavy
 * grind, in Rust compiled to WASM via @msgboard/pow-grinder) off the bot's main event loop, so the
 * game loops never starve it (and vice versa). It receives ONLY encoded bytes (category, data, block
 * hash) + the difficulty factors — never a private key, never the RPC. The main thread does the
 * status/block read and the submit (the `post` orchestration); this thread only stamps.
 *
 * WASM, not the native addon, ON PURPOSE. The package default (`@msgboard/pow-grinder`) loads a
 * platform `.node` prebuild — which is NOT in the self-contained esbuild bundle the fleet ships
 * (ansible/deploy-games-actors.yml esbuild-bundles each script to a standalone .mjs, no node_modules
 * on the box). The portable `@msgboard/pow-grinder/wasm` engine runs anywhere. Its bytes are embedded
 * as base64 (pow-grinder-wasm-b64.ts) and instantiated from memory via `initSync` — so the bundled
 * .mjs carries the WASM inside it and needs neither a `.wasm` on disk nor a `--loader:.wasm=…` flag
 * (the deploy recipe has none). ~1.2–1.8s per stamp vs the native ~0.7s; still off the main loop.
 */
if (!parentPort) throw new Error('pow-worker must be spawned as a worker_threads worker')

// Compile + instantiate the WASM synchronously from the embedded bytes (no fetch, no import.meta.url
// URL load, no filesystem). Pass `{ module }` (the non-deprecated initSync shape). One-time, at load.
initSync({ module: Buffer.from(POW_GRINDER_WASM_B64, 'base64') })

type Job = { id: number; category: string; data: string; wm: number; wd: number; blockHash: string; maxIters: number }
const buf = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex')

parentPort.on('message', (job: Job) => {
  try {
    // Same request shape as the native stamp: { category, data, workMultiplier, workDivisor,
    // blockHash, startNonce, maxIters } → Uint8Array(40) = nonce_be(8) ‖ hash(32), or undefined.
    const out = wasmStamp({
      category: buf(job.category),
      data: buf(job.data),
      workMultiplier: job.wm,
      workDivisor: job.wd,
      blockHash: buf(job.blockHash),
      startNonce: 0,
      maxIters: job.maxIters,
    })
    if (!out) {
      parentPort!.postMessage({ id: job.id, error: 'stamp: maxIters exhausted' })
      return
    }
    // out = nonce_be(8) ‖ hash(32)
    const nonce = `0x${Buffer.from(out.subarray(0, 8)).toString('hex')}`
    const hash = `0x${Buffer.from(out.subarray(8)).toString('hex')}`
    parentPort!.postMessage({ id: job.id, nonce, hash })
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: e instanceof Error ? e.message : String(e) })
  }
})
