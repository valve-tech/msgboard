/// <reference lib="dom" />
// Main-thread wrapper around prover.worker.ts. Framework-agnostic.
//
// Responsibilities, all cheap/I-O-bound so they stay on the main thread:
//   1. resolve + verify the circuit's zkey/wasm bytes (browserLoader — network + IndexedDB + sha256)
//   2. spin up the Web Worker and hand it the bytes as TRANSFERABLES (zero-copy; the 66 MB zkey is
//      moved, not cloned, so it leaves the main thread's heap)
//   3. await the small { proof, publicSignals } back
//
// The actual proving (CPU-heavy, seconds) happens ONLY in the worker — see prover.worker.ts and the
// hard project rule documented there.

import { loadCircuit, type CircuitManifestEntry } from './browserLoader.js'
import type { ProveRequest, ProveResult } from './prover.worker.js'

/**
 * Construct the prover worker. Kept as an overridable factory so the caller controls bundling — under
 * Vite this is `() => new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' })`.
 * (We don't hardcode that here so this module also typechecks/imports in non-Vite contexts.)
 */
export type WorkerFactory = () => Worker

let idCounter = 0

/**
 * Prove a circuit in a Web Worker, off the main thread.
 *
 * @param circuit     manifest entry (has the zkey/wasm file names + expected sha256 + release tag)
 * @param baseUrl     asset base — manifest.release.assetBaseUrl, or a CDN fronting it
 * @param input       the circuit's witness input (public + private signals)
 * @param newWorker   factory that constructs the bundled prover.worker (see WorkerFactory)
 */
export async function proveInWorker(
  circuit: CircuitManifestEntry,
  baseUrl: string,
  input: Record<string, unknown>,
  newWorker: WorkerFactory,
): Promise<{ proof: unknown; publicSignals: string[] }> {
  // Fetch + verify on the main thread (I/O). Throws on sha256 mismatch before any worker spins up.
  const { zkey, wasm } = await loadCircuit(circuit, baseUrl)

  const worker = newWorker()
  const id = ++idCounter
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ProveResult>) => {
        if (e.data.id !== id) return
        if (e.data.error) reject(new Error(e.data.error))
        else resolve({ proof: e.data.proof, publicSignals: e.data.publicSignals ?? [] })
      }
      worker.onerror = (e) => reject(new Error(e.message))
      const req: ProveRequest = { id, input, wasm, zkey }
      // Transfer both buffers — ownership moves to the worker, so the 66 MB zkey leaves the main heap.
      worker.postMessage(req, [wasm, zkey])
    })
  } finally {
    worker.terminate()
  }
}
