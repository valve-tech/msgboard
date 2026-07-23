/// <reference lib="webworker" />
// Vite worker ENTRY for the Wordle PLONK prover (wordle_clue + wordle_solve). Like sudokuProver.worker,
// it exists only so Vite has a concrete module URL to bundle as a Web Worker; the real message handler
// lives in @msgboard/zk-skill's shared prover.worker (registers `self.onmessage`, runs snarkjs.plonk.fullProve
// over the proving key OFF the main thread — the hard project rule). Circuit bytes are passed in per
// request, so the SAME worker serves both wordle circuits.
import '@msgboard/zk-skill/browser/prover.worker'
