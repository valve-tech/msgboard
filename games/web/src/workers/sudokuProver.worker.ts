/// <reference lib="webworker" />
// Vite worker ENTRY for the Sudoku PLONK prover. It exists only so Vite has a concrete module URL to
// bundle as a Web Worker; the actual message handler lives in @msgboard/zk-skill's shared prover.worker,
// which registers `self.onmessage` as an import side-effect (it runs snarkjs.plonk.fullProve over the
// 66 MB proving key here, OFF the main thread — the hard project rule).
//
// The main thread constructs this via
//   new Worker(new URL('../workers/sudokuProver.worker.ts', import.meta.url), { type: 'module' })
// and hands it to `proveInWorker` as the WorkerFactory (see src/lib/sudokuProving.ts).
import '@msgboard/zk-skill/browser/prover.worker'
