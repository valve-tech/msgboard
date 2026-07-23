// Sudoku solution nullifier + witness helpers (JS mirror of
// circuits/sudoku_solve.circom).
//
// M3 role-flip: the player's win proof no longer references any house secret
// (M2's `Poseidon(solution‖salt) == commit` was unprovable for the player and
// house-griefable). Instead the proof binds all 81 solution cells + the public
// `player` into a nullifier, so it cannot be replayed / front-run:
//
//   rowDigest[r] = Poseidon(solution[r*9 .. r*9+8])    (9 inputs) for r = 0..8
//   nullifier    = Poseidon(rowDigest[0..8], player)   (10 inputs)
//
// i.e. a two-level sponge keeping every Poseidon call within circomlib's <=16
// input limit. Must match the circuit bit-for-bit.

import { buildPoseidon } from 'circomlibjs'

let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined

function getPoseidon() {
  poseidonPromise ??= buildPoseidon()
  return poseidonPromise
}

/** The 9 per-row Poseidon(9) digests of a solution (the sponge's first level). */
async function rowDigests(solution: number[]): Promise<bigint[]> {
  if (solution.length !== 81) throw new Error('solution must have 81 cells')
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const digests: bigint[] = []
  for (let r = 0; r < 9; r++) {
    const row = solution.slice(r * 9, r * 9 + 9).map(BigInt)
    digests.push(BigInt(F.toString(poseidon(row))))
  }
  return digests
}

/**
 * The proof's nullifier = Poseidon(rowDigest[0..8], player). Preimage-resistant in
 * `solution` (a watcher who cannot solve the puzzle cannot compute it) and bound to
 * `player` so a copied proof cannot be reused for a different player+round. The
 * contract records spent nullifiers to block replay / double-claim.
 */
export async function sudokuNullifier(solution: number[], player: bigint): Promise<bigint> {
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const digests = await rowDigests(solution)
  return BigInt(F.toString(poseidon([...digests, player])))
}

function groupIndices(): number[][] {
  const groups: number[][] = []
  for (let r = 0; r < 9; r++) {
    groups.push(Array.from({ length: 9 }, (_, c) => r * 9 + c))
  }
  for (let c = 0; c < 9; c++) {
    groups.push(Array.from({ length: 9 }, (_, r) => r * 9 + c))
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const cells: number[] = []
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          cells.push((br * 3 + dr) * 9 + (bc * 3 + dc))
        }
      }
      groups.push(cells)
    }
  }
  return groups
}

export const SUDOKU_GROUPS = groupIndices()

/** Reference (non-circuit) full validity check, mirroring the circuit's constraints. */
export function isValidSolution(puzzle: number[], solution: number[]): boolean {
  if (puzzle.length !== 81 || solution.length !== 81) return false
  for (let i = 0; i < 81; i++) {
    if (solution[i]! < 1 || solution[i]! > 9) return false
    if (puzzle[i] !== 0 && puzzle[i] !== solution[i]) return false
  }
  for (const group of SUDOKU_GROUPS) {
    const seen = new Set<number>()
    for (const idx of group) seen.add(solution[idx]!)
    if (seen.size !== 9) return false
  }
  return true
}

export interface SudokuWitnessInput {
  puzzlePacked: [string, string]
  player: string
  solution: number[]
  [key: string]: unknown
}

/** Cells 0..62 go in packed[0] (63 x 4 = 252 bits); cells 63..80 in packed[1] (18 x 4 = 72 bits). */
const PACK_SPLIT = 63

/**
 * Pack the 81-cell puzzle into 2 field elements, 4 bits per cell, little-endian by cell
 * index. MIRRORED BIT-FOR-BIT in three places that must never drift apart:
 *   - circuits/sudoku_solve.circom  (unpacks via Num2Bits(252) / Num2Bits(72))
 *   - SudokuRules.sol `_packPuzzle` (packs on-chain, so callers still pass 81 cells)
 *   - here
 * A packing-parity test pins all three together.
 *
 * WHY PACK AT ALL: a PLONK zkey stores one Lagrange polynomial per PUBLIC input (5n field
 * elements each). As 81 separate public inputs the sudoku proving key was 960 MB — 90.7% of
 * it that one section — which cannot be shipped to a browser, and the PLAYER must prove
 * (they are the one who knows the solution). Packed, it is 66 MB. See the circuit header.
 *
 * WHY TWO ELEMENTS AND NOT ONE: a cell has TEN states (0 = blank, plus 1..9), so the floor is
 * 81*log2(10) = 269.1 bits > the ~253 usable bits of a BN254 element. The largest base that
 * fits one element is 8; we need 10. One element is impossible for ANY encoding — base 9
 * would need 256.8 bits and still cannot represent a blank.
 */
export function packPuzzle(puzzle: number[]): [bigint, bigint] {
  if (puzzle.length !== 81) throw new Error(`packPuzzle: expected 81 cells, got ${puzzle.length}`)
  let lo = 0n
  let hi = 0n
  for (let i = 0; i < puzzle.length; i++) {
    const cell = puzzle[i]
    if (cell === undefined || !Number.isInteger(cell) || cell < 0 || cell > 9) {
      throw new Error(`packPuzzle: cell ${i} must be an integer in [0,9], got ${cell}`)
    }
    if (i < PACK_SPLIT) lo |= BigInt(cell) << BigInt(4 * i)
    else hi |= BigInt(cell) << BigInt(4 * (i - PACK_SPLIT))
  }
  return [lo, hi]
}

/** Inverse of packPuzzle — used by tests to pin the round-trip. */
export function unpackPuzzle(packed: [bigint, bigint]): number[] {
  const out: number[] = []
  for (let i = 0; i < 81; i++) {
    const word = i < PACK_SPLIT ? packed[0] : packed[1]
    const shift = BigInt(4 * (i < PACK_SPLIT ? i : i - PACK_SPLIT))
    out.push(Number((word >> shift) & 0xfn))
  }
  return out
}

/**
 * Build the circuit witness input for a solve of `puzzle` by `player`. The proof binds
 * to `player` (an address as a field element) via the nullifier; the same builder is
 * used both for the HOUSE's solvability proof at open (any player value) and the
 * PLAYER's win proof (player = the table's player).
 *
 * Takes the puzzle as 81 plain cells and packs it here, so callers never handle the
 * packed encoding — exactly as SudokuRules.checkSolve does on-chain.
 */
export async function buildSudokuWitnessInput(params: {
  puzzle: number[]
  solution: number[]
  player: bigint
}): Promise<SudokuWitnessInput> {
  const [lo, hi] = packPuzzle(params.puzzle)
  return {
    puzzlePacked: [lo.toString(), hi.toString()],
    player: params.player.toString(),
    solution: params.solution,
  }
}
