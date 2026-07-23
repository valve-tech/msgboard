// Browser-side drivers for the two ZK-Wordle proofs, mirroring src/lib/sudokuProving.ts:
//   • wordle_clue  — the SETTER proves a single guess was scored honestly (public [commit, guess[5],
//     clue[5]]). Built + proved per guess during play so the guesser sees trustworthy colours.
//   • wordle_solve — the SOLVER proves their committed ordered guess sequence's first all-green
//     position against the setter's committed word + the committed dictionary (public [commit,
//     guessesCommit, dictRoot, guessesUsed]). The OPTIONAL on-chain anchor (WordleLog.logSolve).
//
// PROVING ALWAYS RUNS IN A WEB WORKER (never the main thread — the hard project rule). Verification
// (snarkjs.plonk.verify) is milliseconds of field arithmetic, so it stays on the main thread; it is how
// each party checks an incoming proof (a failing verify on a clue = a cheating setter).
import { buildWordleWitnessInput, type Clue } from '@msgboard/zk-skill/wordle'
import { WORDLE_SOLVE_MAX_GUESSES, type WordleSolveWitnessInput } from '@msgboard/zk-skill/wordleSolve'
import { proveInWorker, type CircuitManifestEntry } from '@msgboard/zk-skill/browser'
import clueVkey from './vkeys/wordle_clue_vkey.json'
import solveVkey from './vkeys/wordle_solve_vkey.json'

// ── published proving artifacts (from examples/games/zk-skill/proving-keys.manifest.json, release
//    tag `proving-keys-v2`). The loader fetches these from the GitHub release, caches them in
//    IndexedDB keyed by sha256, and verifies the bytes before proving — a corrupted/swapped key can
//    only FAIL to prove, never forge (the vkey/on-chain verifier is the trust anchor). ──
export const WORDLE_CLUE_CIRCUIT: CircuitManifestEntry = {
  circuit: 'wordle_clue',
  zkey: { file: 'wordle_clue_plonk.zkey', sha256: '80149519e15316db3d1e7a7817c3837f71b3e885c801bb0ae87ee57fec413ef1', bytes: 6427092 },
  wasm: { file: 'wordle_clue.wasm', sha256: 'f72a630ed215c0f7171f60805413b5e6983d4936f28a6a50b3cc9aab6253691d', bytes: 2313937 },
  release: 'proving-keys-v2',
}
export const WORDLE_SOLVE_CIRCUIT: CircuitManifestEntry = {
  circuit: 'wordle_solve',
  zkey: { file: 'wordle_solve_plonk.zkey', sha256: '52a05d10d62ad228745f94488f06f7ba337a240cfe917f5290228d33b9196a09', bytes: 32826828 },
  wasm: { file: 'wordle_solve.wasm', sha256: '52955d2547ddb05c5cd268b1eca9962a869a84ab1cd524c6685b9fee437a0462', bytes: 2683842 },
  release: 'proving-keys-v2',
}

// The box mirror of release `proving-keys-v2` — GitHub release downloads send no CORS headers, so
// browsers can't fetch them; see sudokuProving.ts for the full note.
const ASSET_BASE_URL = 'https://games.msgboard.xyz/proving-keys'

const newProverWorker = () =>
  new Worker(new URL('../workers/wordleProver.worker.ts', import.meta.url), { type: 'module' })

const newWitnessWorker = () =>
  new Worker(new URL('../workers/wordleSolveWitness.worker.ts', import.meta.url), { type: 'module' })

/** Lazily resolve snarkjs's browser build for main-thread verify + calldata formatting (NOT proving). */
async function getSnarkjs(): Promise<any> {
  const mod: any = await import('snarkjs')
  return mod.default ?? mod
}

// ── wordle_clue: prove (setter) + verify (both) ──────────────────────────────────────────────────

export type ClueProof = {
  /** the honest colours [0=grey,1=yellow,2=green] the proof commits to. */
  clue: Clue[]
  /** the raw PLONK proof object (verify with verifyWordleClue). */
  proof: unknown
  /** publicSignals = [commit, guess[0..4], clue[0..4]] (11 field-element strings). */
  publicSignals: string[]
}

/**
 * SETTER: score `guess` against the hidden `word` and prove (in a worker) the colouring is honest.
 * `word`/`salt` are the setter's private inputs; `commit = Poseidon(word, salt)` is public.
 */
export async function proveWordleClue(params: {
  word: number[]
  salt: bigint
  guess: number[]
}): Promise<ClueProof> {
  const input = await buildWordleWitnessInput(params) // cheap single-Poseidon commit on the main thread
  const { proof, publicSignals } = await proveInWorker(WORDLE_CLUE_CIRCUIT, ASSET_BASE_URL, input, newProverWorker)
  if (publicSignals.length !== 11) {
    throw new Error(`wordle_clue: expected 11 public signals, got ${publicSignals.length}`)
  }
  return { clue: input.clue as Clue[], proof, publicSignals }
}

/** Verify a wordle_clue proof (main thread). Returns false for a dishonest/garbled clue. */
export async function verifyWordleClue(publicSignals: string[], proof: unknown): Promise<boolean> {
  const snarkjs = await getSnarkjs()
  return snarkjs.plonk.verify(solveOrClue(clueVkey), publicSignals, proof)
}

/** Decode the [commit, guess[5], clue[5]] triple from a clue proof's public signals. */
export function decodeCluePublicSignals(publicSignals: string[]): { commit: bigint; guess: number[]; clue: Clue[] } {
  if (publicSignals.length !== 11) throw new Error('wordle_clue: expected 11 public signals')
  return {
    commit: BigInt(publicSignals[0]!),
    guess: publicSignals.slice(1, 6).map((s) => Number(s)),
    clue: publicSignals.slice(6, 11).map((s) => Number(s) as Clue),
  }
}

// ── wordle_solve: prove (solver) + verify + logSolve calldata ─────────────────────────────────────

export type SolveProof = {
  /** the 24-field PLONK proof, in WordleLog.logSolve's `uint256[24]` order. */
  calldata: bigint[]
  /** the raw PLONK proof object (verify with verifyWordleSolve). */
  proof: unknown
  /** publicSignals = [commit, guessesCommit, dictRoot, guessesUsed]. */
  publicSignals: string[]
  commit: bigint
  guessesCommit: bigint
  dictRoot: bigint
  guessesUsed: number
}

/**
 * SOLVER: prove knowledge of the revealed word solving the committed guess sequence. Builds the
 * witness (incl. the heavy dictionary Merkle tree) in a worker, then generates the PLONK proof in the
 * prover worker. `guesses` MUST be exactly WORDLE_SOLVE_MAX_GUESSES entries (pad trailing slots with a
 * non-solving filler; guessesUsed is FORCED in-circuit as the first all-green position).
 */
export async function proveWordleSolve(params: {
  word: number[]
  salt: bigint
  guesses: number[][]
}): Promise<SolveProof> {
  if (params.guesses.length !== WORDLE_SOLVE_MAX_GUESSES) {
    throw new Error(`wordle_solve needs exactly ${WORDLE_SOLVE_MAX_GUESSES} committed guesses`)
  }
  const input = await buildSolveWitnessInWorker(params)
  const { proof, publicSignals } = await proveInWorker(WORDLE_SOLVE_CIRCUIT, ASSET_BASE_URL, input, newProverWorker)
  if (publicSignals.length !== 4) {
    throw new Error(`wordle_solve: expected 4 public signals, got ${publicSignals.length}`)
  }
  const calldata = await proofToCalldata(proof, publicSignals)
  return {
    calldata,
    proof,
    publicSignals,
    commit: BigInt(publicSignals[0]!),
    guessesCommit: BigInt(publicSignals[1]!),
    dictRoot: BigInt(publicSignals[2]!),
    guessesUsed: Number(publicSignals[3]!),
  }
}

/** Verify a wordle_solve proof (main thread). */
export async function verifyWordleSolve(publicSignals: string[], proof: unknown): Promise<boolean> {
  const snarkjs = await getSnarkjs()
  return snarkjs.plonk.verify(solveOrClue(solveVkey), publicSignals, proof)
}

/** Build the wordle_solve witness (dictionary tree + Merkle path) in a Web Worker, off the main thread. */
function buildSolveWitnessInWorker(params: {
  word: number[]
  salt: bigint
  guesses: number[][]
}): Promise<WordleSolveWitnessInput> {
  return new Promise((resolve, reject) => {
    const worker = newWitnessWorker()
    const id = Date.now()
    worker.onmessage = (e: MessageEvent<{ id: number; input?: WordleSolveWitnessInput; error?: string }>) => {
      if (e.data.id !== id) return
      worker.terminate()
      if (e.data.error || !e.data.input) reject(new Error(e.data.error ?? 'witness build failed'))
      else resolve(e.data.input)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ id, word: params.word, salt: params.salt.toString(), guesses: params.guesses })
  })
}

/**
 * The 24 PLONK proof field elements in the exact order `verifyProof(uint256[24], uint256[4])` expects
 * — snarkjs's own `plonk.exportSolidityCallData` order, so the calldata can never drift from the
 * on-chain verifier (mirrors sudokuProving.proofToCalldata). snarkjs here is only string/field
 * formatting (NOT proving), so it stays on the main thread.
 */
async function proofToCalldata(proof: unknown, publicSignals: string[]): Promise<bigint[]> {
  const snarkjs = await getSnarkjs()
  const calldata: string = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals)
  const fields = (calldata.match(/0x[0-9a-fA-F]+/g) ?? []).map((h) => BigInt(h))
  const expected = 24 + publicSignals.length
  if (fields.length !== expected) {
    throw new Error(`wordle_solve: expected ${expected} calldata fields (24 proof + ${publicSignals.length} public), got ${fields.length}`)
  }
  return fields.slice(0, 24)
}

/** JSON-imported vkeys are typed as their inferred literal shape; snarkjs wants a plain object. */
function solveOrClue(vkey: unknown): any {
  return vkey
}
