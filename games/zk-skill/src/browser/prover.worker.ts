/// <reference lib="webworker" />
// PLONK prover running INSIDE a Web Worker — NEVER on the browser main thread.
//
// HARD PROJECT RULE (same as the PoW grinder): heavy crypto must never block the UI thread. Witness
// generation + PLONK proving over a 66 MB proving key is seconds of pure CPU; running it on the main
// thread would freeze the tab. So it lives here, in a worker.
//
// THE 66 MB ZKEY FLOWS: the main thread (prover.ts) loads + verifies the zkey/wasm bytes via
// browserLoader.loadArtifact (I/O, cheap), then postMessages them to THIS worker as transferable
// ArrayBuffers — a zero-copy ownership handoff, not a clone. From here on the big buffer is owned by
// the worker; the main thread no longer holds it. snarkjs.plonk.fullProve consumes them here, off the
// UI thread. Only the small proof + publicSignals travel back.
//
// snarkjs resolves to its browser ESM build (package.json "exports": { "browser": ".../browser.esm.js" })
// under a bundler with the browser condition (Vite does this for worker bundles).
import * as snarkjs from 'snarkjs'

export interface ProveRequest {
  id: number
  input: Record<string, unknown>
  /** Witness-generator wasm bytes (verified upstream by browserLoader). */
  wasm: ArrayBuffer
  /** PLONK proving key bytes (the big one — verified upstream by browserLoader). */
  zkey: ArrayBuffer
}

export interface ProveResult {
  id: number
  proof?: unknown
  publicSignals?: string[]
  error?: string
}

self.onmessage = async (e: MessageEvent<ProveRequest>) => {
  const { id, input, wasm, zkey } = e.data
  try {
    // snarkjs accepts Uint8Array views for both the wasm and the zkey in the browser.
    const { proof, publicSignals } = await snarkjs.plonk.fullProve(
      input,
      new Uint8Array(wasm),
      new Uint8Array(zkey),
    )
    const msg: ProveResult = { id, proof, publicSignals }
    ;(self as unknown as Worker).postMessage(msg)
  } catch (err) {
    const msg: ProveResult = { id, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
