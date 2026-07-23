/// <reference lib="webworker" />
import init, { stamp } from '@msgboard/pow-grinder/wasm'

/**
 * MsgBoard proof-of-work grinder — a PURE STAMPER running in a Web Worker, NEVER on the UI thread
 * (the grind would freeze the tab). It mints the stamp via the WASM build of the same Rust core the
 * bots use natively, off the main thread.
 *
 * KEY BOUNDARY: receives only encoded bytes (category, data, block hash) + the difficulty factors —
 * never a private key, never the RPC. The main thread reads the head/difficulty and submits (the
 * `post` orchestration); this worker only stamps.
 */
type Job = {
  id: number
  category: Uint8Array
  data: Uint8Array
  wm: number
  wd: number
  blockHash: Uint8Array
  maxIters: number
}

let ready: Promise<unknown> | null = null

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, category, data, wm, wd, blockHash, maxIters } = e.data
  try {
    if (!ready) ready = init() // instantiate the wasm module once, lazily
    await ready
    const packed = stamp({ category, data, workMultiplier: wm, workDivisor: wd, blockHash, startNonce: 0, maxIters })
    if (!packed) {
      ;(self as unknown as Worker).postMessage({ id, error: 'stamp: maxIters exhausted' })
      return
    }
    // packed = nonce_be(8) ‖ hash(32); hand the buffer back (transferable) and let the caller unpack.
    ;(self as unknown as Worker).postMessage({ id, packed }, [packed.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
