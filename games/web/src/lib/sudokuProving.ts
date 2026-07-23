// Browser-side driver for the Sudoku solve proof. Wires @msgboard/zk-skill's in-worker PLONK prover to
// this app: builds the witness input, proves IN A WEB WORKER (never the main thread — the hard
// project rule; witness-gen + PLONK over the 66 MB key is seconds of pure CPU), and formats the
// result into the `uint256[24] proof` + `nullifier` + `player` that SudokuLog.logSolve expects.
import { buildSudokuWitnessInput } from '@msgboard/zk-skill/sudoku'
import { proveInWorker, type CircuitManifestEntry } from '@msgboard/zk-skill/browser'

/**
 * The `sudoku_solve` circuit's published proving artifacts. Copied from
 * examples/games/zk-skill/proving-keys.manifest.json (release tag `proving-keys-v2`). The loader
 * fetches these from the GitHub release, caches them in IndexedDB keyed by sha256, and verifies the
 * bytes before proving — a corrupted/swapped key can only FAIL to prove, never forge (the on-chain
 * verifier is the real trust anchor), so the untrusted host is fine.
 */
export const SUDOKU_SOLVE_CIRCUIT: CircuitManifestEntry = {
  circuit: 'sudoku_solve',
  zkey: {
    file: 'sudoku_solve_plonk.zkey',
    sha256: 'e2a7754da2043dc98cf7314a80e44873ea61faf032e70451f85a25c091e70df4',
    bytes: 66346804,
  },
  wasm: {
    file: 'sudoku_solve.wasm',
    sha256: 'b16abdc7e5b7a09772d83ef9d3d28fb17585fdac239e2e1655839c83eac14752',
    bytes: 4308891,
  },
  release: 'proving-keys-v2',
}

// The box mirror of release `proving-keys-v2` (sha256-verified against the manifest at upload).
// GitHub release downloads send NO CORS headers on any hop of their redirect chain, so a browser
// fetch() of the artifacts fails outright — same-origin serving (plus ACAO * for localhost dev)
// is the fix, and the sha256 check below keeps the mirror honest.
const ASSET_BASE_URL = 'https://games.msgboard.xyz/proving-keys'

/** The bundled Vite worker entry for the PLONK prover (src/workers/sudokuProver.worker.ts). */
const newProverWorker = () =>
  new Worker(new URL('../workers/sudokuProver.worker.ts', import.meta.url), { type: 'module' })

/**
 * The 24 PLONK proof field elements, in the exact order the generated Solidity
 * `verifyProof(uint256[24], uint256[4])` expects — i.e. snarkjs's own `plonk.exportSolidityCallData`
 * order. Derived from that function (rather than hand-packing proof.A/B/…) so the calldata can never
 * drift from the on-chain verifier — mirrors zk-skill's harness.proofToCalldata. snarkjs here is only
 * doing string/field formatting (NOT proving), so it stays on the main thread; it resolves to the same
 * browser build the worker uses.
 */
async function proofToCalldata(proof: unknown, publicSignals: string[]): Promise<bigint[]> {
  const mod: any = await import('snarkjs')
  const snarkjs = mod.default ?? mod
  const calldata: string = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals)
  const fields = (calldata.match(/0x[0-9a-fA-F]+/g) ?? []).map((h) => BigInt(h))
  const expected = 24 + publicSignals.length
  if (fields.length !== expected) {
    throw new Error(`sudoku: expected ${expected} calldata fields (24 proof + ${publicSignals.length} public), got ${fields.length}`)
  }
  return fields.slice(0, 24)
}

export type SudokuProof = {
  /** The 24-field PLONK proof for SudokuLog.logSolve's `uint256[24] proof`. */
  proof: bigint[]
  /** publicSignals[0] — binds the 81 solution cells + player; the contract records it spent. */
  nullifier: bigint
  /** publicSignals[3] — the player the proof is bound to (must equal `player` below). */
  player: bigint
  /** The raw 4 public signals [nullifier, packed0, packed1, player], for sanity checks. */
  publicSignals: string[]
}

/**
 * Prove a Sudoku solution in a Web Worker and return the logSolve-ready calldata parts.
 *
 * @param puzzle    the 81-cell published board (0 = blank clue cell)
 * @param solution  the 81-cell completed grid
 * @param player    the connected wallet address as a field element (BigInt(address))
 */
export async function proveSudokuSolve(params: {
  puzzle: number[]
  solution: number[]
  player: bigint
}): Promise<SudokuProof> {
  const input = await buildSudokuWitnessInput(params)
  const { proof, publicSignals } = await proveInWorker(SUDOKU_SOLVE_CIRCUIT, ASSET_BASE_URL, input, newProverWorker)
  if (publicSignals.length !== 4) {
    throw new Error(`sudoku: expected 4 public signals, got ${publicSignals.length}`)
  }
  const nullifier = BigInt(publicSignals[0]!)
  const provenPlayer = BigInt(publicSignals[3]!)
  if (provenPlayer !== params.player) {
    throw new Error('sudoku: proof player does not match the connected wallet')
  }
  const calldata = await proofToCalldata(proof, publicSignals)
  return { proof: calldata, nullifier, player: provenPlayer, publicSignals }
}
