/// <reference lib="webworker" />
// Web Worker that builds the `wordle_solve` witness input OFF the main thread.
//
// Why a worker: the solve proof binds the winning word to the committed dictionary via a Merkle path,
// so the witness build must construct the full 12,972-word dictionary tree (2^14 leaves) with Poseidon
// — tens of thousands of hashes, seconds of pure CPU. That must never run on the UI thread (same rule
// as the PoW grinder + the PLONK prover). This worker imports the JS builders from
// @msgboard/zk-skill/wordleSolve, produces the plain (string/number) witness object, and posts it back; the
// PLONK proof itself is then generated in the separate prover worker (see wordleProving.ts).

import {
  buildDictTree,
  buildWordleSolveWitnessInput,
  WORDLE_VALID_GUESSES,
  WORDLE_SOLVE_MAX_GUESSES,
  type WordleSolveWitnessInput,
} from '@msgboard/zk-skill/wordleSolve'

type Job = {
  id: number
  word: number[]
  salt: string
  /** the player's committed ordered guesses (exactly WORDLE_SOLVE_MAX_GUESSES entries, as letter indices). */
  guesses: number[][]
}

type Result = { id: number; input?: WordleSolveWitnessInput; dictRoot?: string; error?: string }

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, word, salt, guesses } = e.data
  try {
    if (guesses.length !== WORDLE_SOLVE_MAX_GUESSES) {
      throw new Error(`wordle_solve needs exactly ${WORDLE_SOLVE_MAX_GUESSES} committed guesses`)
    }
    // Heavy: full dictionary Merkle tree (Poseidon over 2^14 leaves). This is why we are in a worker.
    const dict = await buildDictTree([...WORDLE_VALID_GUESSES])
    const input = await buildWordleSolveWitnessInput({ word, salt: BigInt(salt), guesses, dict })
    const msg: Result = { id, input, dictRoot: dict.root.toString() }
    ;(self as unknown as Worker).postMessage(msg)
  } catch (err) {
    const msg: Result = { id, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
