// ZK-Wordle SETTLEMENT proof helpers (JS mirror of circuits/wordle_solve.circom).
//
// M3 goal 1 (trustless guess-sequence binding) + goal 2 (dictionary membership).
//
// Where wordle_clue proves a SINGLE clue is honestly scored (used during play so the player sees
// honest feedback), wordle_solve is the PERMISSIONLESS SETTLE proof: it binds the player's whole
// ORDERED guess sequence to a commitment and proves, in ZK, the first all-green position — so the
// payout multiplier scale (guesses-used) is FORCED by the proof, not co-signed by the house.
//
// Construction (see the circuit header for the constraint-level spec):
//   • The player commits their ordered guesses up front:
//       packedGuess[i] = Σ_j guess[i][j] · 26^j            (base-26, little-endian; each letter <26)
//       guessesCommit  = Poseidon(packedGuess[0..maxGuesses-1])
//     `guessesCommit` is pinned in the house-signed open terms BEFORE play (non-adaptive variant),
//     so the sequence cannot be reordered after the fact.
//   • The win proof (prover knows word+salt) proves against the committed word C=Poseidon(word,salt):
//       - packedWord = Σ_j word[j]·26^j
//       - isSolved[i] = (packedGuess[i] == packedWord)      (all-green ⟺ packed equal, given ranges)
//       - guessesUsed = the FIRST i with isSolved[i] (1-based); every earlier guess is NOT a solve
//       - packedWord ∈ dictRoot                              (Merkle membership → the answer, and thus
//                                                             the winning guess, is a real word)
//   Player cannot understate guesses-used (the sequence is fixed and every earlier guess is checked
//   non-solving), cannot fake a solve (needs a committed guess == the committed word), and cannot pass
//   off a non-dictionary word (the winning word must be in the committed dictionary root).

import { buildPoseidon } from 'circomlibjs'
import { wordToIndices } from './wordle.js'
import { WORDLE_VALID_GUESSES } from './dictionaries/wordle-valid-guesses.js'

export { WORDLE_VALID_GUESSES }

export const WORDLE_SOLVE_MAX_GUESSES = 6

/**
 * PRODUCTION Merkle depth of the dictionary tree: 2^14 = 16,384 leaves — the depth the DEPLOYED
 * circuit (`component main = WordleSolve(6, 14)`), the committed on-chain verifier, and the committed
 * `dictRoot` are all built against. 14 is the smallest depth that holds the full 12,972-word canonical
 * original-Wordle valid-guess list (WORDLE_VALID_GUESSES).
 *
 * This is the ONE depth every proof in this package uses. The circuit is fixed-depth, so a proof built
 * at any other depth cannot verify against the deployed verifier — do NOT introduce a second depth.
 */
export const DICT_DEPTH = 14
/** Explicit alias for the production depth, for call sites that want the intent spelled out. */
export const PROD_DICT_DEPTH = DICT_DEPTH

/**
 * A small TEST dictionary (16 valid 5-letter words) for fast, deterministic unit tests. It is committed
 * at the SAME production depth (DICT_DEPTH = 14) as the real dictionary — only the word COUNT is small,
 * which keeps the fixtures/tests focused; the Merkle depth (and thus the proving cost) matches
 * production exactly. `crane`/`proxy` are the words the settle e2e/fixtures solve on, so they MUST stay
 * in the set. The DEPLOYED dictionary is WORDLE_VALID_GUESSES (see genWordleSolve.ts / settle.ts).
 */
export const TEST_DICTIONARY: readonly string[] = [
  'crane', 'proxy', 'slate', 'ghost', 'dozen', 'jumbo', 'unfit', 'humid',
  'brick', 'plumb', 'wight', 'zesty', 'mocha', 'fjord', 'glyph', 'vibex',
]

let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined
function getPoseidon() {
  poseidonPromise ??= buildPoseidon()
  return poseidonPromise
}

/** packedWord = Σ_j letter[j] · 26^j (base-26, little-endian). Matches the circuit's Horner packing. */
export function packWord(word: number[]): bigint {
  if (word.length !== 5) throw new Error('word must be 5 letters')
  let acc = 0n
  for (let j = 4; j >= 0; j--) {
    const v = word[j]!
    if (v < 0 || v > 25) throw new Error(`letter out of range: ${v}`)
    acc = acc * 26n + BigInt(v)
  }
  return acc
}

/** Poseidon(packedGuess[0..maxGuesses-1]) — the ordered guess-sequence commitment. */
export async function guessesCommit(
  guesses: number[][],
  maxGuesses = WORDLE_SOLVE_MAX_GUESSES,
): Promise<bigint> {
  if (guesses.length !== maxGuesses) {
    throw new Error(`guessesCommit needs exactly ${maxGuesses} committed guesses`)
  }
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const packed = guesses.map(packWord)
  return BigInt(F.toString(poseidon(packed)))
}

// ---- dictionary Merkle tree (leaf = packedWord, internal node = Poseidon(2)) --------------------

export interface DictTree {
  root: bigint
  depth: number
  /** leaves in insertion order (the committed dictionary), padded to 2^depth with a sentinel. */
  leaves: bigint[]
  /** the padding sentinel used for empty leaves. */
  padLeaf: bigint
}

/** A packedWord that no real 5-letter word can equal (26^5 = 11_881_376 is the exclusive upper bound). */
export const DICT_PAD_LEAF = 26n ** 5n

/**
 * Build a fixed-depth Merkle tree over a dictionary of 5-letter words. Leaves are `packWord(word)`;
 * the tree is padded to 2^depth with DICT_PAD_LEAF. Internal nodes are Poseidon(left, right).
 */
export async function buildDictTree(words: string[], depth = DICT_DEPTH): Promise<DictTree> {
  const size = 1 << depth
  if (words.length > size) throw new Error(`dictionary too large for depth ${depth} (max ${size})`)
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const h2 = (l: bigint, r: bigint) => BigInt(F.toString(poseidon([l, r])))

  const leaves: bigint[] = words.map((w) => packWord(wordToIndices(w)))
  while (leaves.length < size) leaves.push(DICT_PAD_LEAF)

  let level = leaves.slice()
  while (level.length > 1) {
    const next: bigint[] = []
    for (let i = 0; i < level.length; i += 2) next.push(h2(level[i]!, level[i + 1]!))
    level = next
  }
  return { root: level[0]!, depth, leaves, padLeaf: DICT_PAD_LEAF }
}

export interface MerklePath {
  pathElements: bigint[]
  pathIndices: number[] // 0 => current node is the LEFT child, 1 => right child
}

/** Merkle inclusion path for the word at `leafIndex` (or found by value) in the tree. */
export async function dictMerklePath(tree: DictTree, leaf: bigint): Promise<MerklePath> {
  const idx = tree.leaves.findIndex((v) => v === leaf)
  if (idx < 0) throw new Error('word not in dictionary')
  const poseidon = await getPoseidon()
  const F = poseidon.F
  const h2 = (l: bigint, r: bigint) => BigInt(F.toString(poseidon([l, r])))

  const pathElements: bigint[] = []
  const pathIndices: number[] = []
  let level = tree.leaves.slice()
  let i = idx
  while (level.length > 1) {
    const isRight = i & 1
    const sib = isRight ? level[i - 1]! : level[i + 1]!
    pathElements.push(sib)
    pathIndices.push(isRight) // 1 if current is the right child
    const next: bigint[] = []
    for (let k = 0; k < level.length; k += 2) next.push(h2(level[k]!, level[k + 1]!))
    level = next
    i >>= 1
  }
  return { pathElements, pathIndices }
}

export interface WordleSolveWitnessInput {
  commit: string
  guessesCommit: string
  dictRoot: string
  guessesUsed: string
  word: number[]
  salt: string
  guess: number[][]
  pathElements: string[]
  pathIndices: string[]
  [key: string]: unknown
}

/**
 * Build the wordle_solve witness. `guesses` is the player's committed ORDERED sequence (exactly
 * maxGuesses entries); `word` is the house's hidden word (which some committed guess must equal for a
 * settleable win). Throws if the sequence never solves (settlement is a win-only proof).
 */
export async function buildWordleSolveWitnessInput(params: {
  word: number[]
  salt: bigint
  guesses: number[][]
  dict: DictTree
  maxGuesses?: number
}): Promise<WordleSolveWitnessInput> {
  const maxGuesses = params.maxGuesses ?? WORDLE_SOLVE_MAX_GUESSES
  if (params.guesses.length !== maxGuesses) {
    throw new Error(`wordle_solve needs exactly ${maxGuesses} committed guesses`)
  }
  const poseidon = await getPoseidon()
  const F = poseidon.F

  const commit = BigInt(F.toString(poseidon([...params.word.map(BigInt), params.salt])))
  const gCommit = await guessesCommit(params.guesses, maxGuesses)
  const packedWord = packWord(params.word)

  // first all-green position (1-based); 0 == never solved
  const solvedAt = params.guesses.findIndex((g) => packWord(g) === packedWord) + 1
  if (solvedAt === 0) throw new Error('wordle_solve: committed sequence never solves — no win to prove')

  const path = await dictMerklePath(params.dict, packedWord)

  return {
    commit: commit.toString(),
    guessesCommit: gCommit.toString(),
    dictRoot: params.dict.root.toString(),
    guessesUsed: solvedAt.toString(),
    word: params.word,
    salt: params.salt.toString(),
    guess: params.guesses,
    pathElements: path.pathElements.map((x) => x.toString()),
    pathIndices: path.pathIndices.map((x) => x.toString()),
  }
}
