// @msgboard/zk-skill — the off-chain E2E settle for the ZK skill games: generate REAL PLONK proofs,
// verify them, derive the round RESULT from the proven public signals, and settle the payout through
// the canonical @msgboard/games skill modules. This is the proof-driven analog of
// @msgboard/zk-settle's settle.ts (which does the same for the RNG privacy track), and it ties the
// circuits (M0), the on-chain verifiers (M1), and the payout economics together into a full round.
//
// The payout MATH is not re-implemented here — it is imported from @msgboard/games so the
// off-chain settle, the on-chain SkillPayouts.sol mirror, and this integration can never drift.

import { setupCircuit, prove, verify, type CircuitSetup } from './harness.js'
import { buildWordleWitnessInput, scoreGuess, wordToIndices, type Clue } from './wordle.js'
import {
  buildDictTree,
  buildWordleSolveWitnessInput,
  guessesCommit as computeGuessesCommit,
  WORDLE_VALID_GUESSES,
  WORDLE_SOLVE_MAX_GUESSES,
  type DictTree,
} from './wordleSolve.js'
import { buildSudokuWitnessInput } from './sudoku.js'
import {
  wordle,
  WORDLE_MAX_GUESSES,
  sudokuElapsed,
  type WordleParams,
  type WordleResult,
  type SudokuSolveEntry,
  type SkillOutcome,
} from '@msgboard/games'

// Filler for the committed guess-sequence's unused (post-solve) slots — a non-word (so it is never a
// false solve) with valid letters. Only ever appended AFTER the solving guess, so it can't affect the
// proven first all-green position.
const WORDLE_FILLER = wordToIndices('xxxxx')

// Compiling + setting up a circuit is the slow step; cache per circuit so a multi-guess Wordle round
// (one proof per guess) reuses one setup. Every circuit shares the ONE universal Hermez ptau, so
// there is no per-circuit ptau power to pass or get wrong (see harness.ts).
const setupCache = new Map<string, CircuitSetup>()
function setupFor(name: string): CircuitSetup {
  let s = setupCache.get(name)
  if (!s) {
    s = setupCircuit(name)
    setupCache.set(name, s)
  }
  return s
}

const isAllGreen = (clue: Clue[]): boolean => clue.length === 5 && clue.every((t) => t === 2)

// The committed dictionary tree is the same for every round; build it once. This is the REAL
// production dictionary (the full 12,972-word canonical Wordle valid-guess list) at PROD_DICT_DEPTH,
// so `solveProof.dictRoot` is the exact root a mainnet setWordleDictRoot commits — a round proof here
// verifies against the committed on-chain dictRoot with no toy-dictionary substitution.
let defaultDictPromise: Promise<DictTree> | undefined
function defaultDict(): Promise<DictTree> {
  defaultDictPromise ??= buildDictTree([...WORDLE_VALID_GUESSES])
  return defaultDictPromise
}

/** One house-proven clue in a Wordle round: the guess, its honest clue, and the proof of that. */
export interface WordleClueProof {
  guess: number[]
  clue: Clue[]
  proof: unknown
  publicSignals: string[]
  verified: boolean
}

/**
 * The permissionless SETTLEMENT proof for a solved round: binds the committed ordered guess sequence
 * (`guessesCommit`) + committed word to the PROVEN first all-green position (`guessesUsed`) with the
 * answer in the committed dictionary (`dictRoot`). This is what a fully trustless on-chain settle
 * verifies — no house co-signature over guesses-used. Present only on a win.
 */
export interface WordleSolveProof {
  proof: unknown
  publicSignals: string[]
  verified: boolean
  guessesUsed: number
  guessesCommit: string
  dictRoot: string
}

export interface WordleRoundResult {
  clueProofs: WordleClueProof[]
  solveProof?: WordleSolveProof
  result: WordleResult
  outcome: SkillOutcome
}

/**
 * Play + settle one full ZK-Wordle round. The house holds `word` (+`salt`) behind a commitment; for
 * each of the player's `guesses` (in order) it scores the honest clue and PROVES it against the
 * commitment (wordle_clue.circom). The round result is the first guess that scores all-green (the
 * solve) and how many guesses that took; the payout comes straight from `wordle.settleRound`. A round
 * that never goes all-green (within maxGuesses) is a loss — and every clue is still proven, so the
 * loss is auditable.
 *
 * Every returned clue proof is INDEPENDENTLY verified here; a failing verify throws (the house cannot
 * pass off a dishonest clue). Stops proving clues once solved — later guesses are moot.
 *
 * On a WIN it additionally produces the M3 permissionless settlement proof (wordle_solve): it commits
 * the ordered guess sequence (padded to maxGuesses), then proves the first all-green position
 * (guesses-used) against the committed word + committed dictionary — the exact proof the on-chain
 * settleWordle verifies with no house co-signature. This proof is also verified here (a failing verify
 * throws) and its proven guesses-used is cross-checked against the observed solve position.
 */
export async function playWordleRound(params: {
  word: number[]
  salt: bigint
  guesses: number[][]
  stake: bigint
  maxGuesses?: number
  dict?: DictTree
}): Promise<WordleRoundResult> {
  const maxGuesses = params.maxGuesses ?? WORDLE_MAX_GUESSES
  if (params.guesses.length > maxGuesses) throw new Error('wordle: more guesses than allowed')
  const setup = setupFor('wordle_clue')

  const clueProofs: WordleClueProof[] = []
  let solvedAt = 0 // 1-based guesses-used; 0 == not solved
  for (let i = 0; i < params.guesses.length; i++) {
    const guess = params.guesses[i]!
    const clue = scoreGuess(params.word, guess)
    const input = await buildWordleWitnessInput({ word: params.word, salt: params.salt, guess, clue })
    const { proof, publicSignals } = await prove(setup, input)
    const verified = await verify(setup, publicSignals, proof)
    if (!verified) throw new Error(`wordle: clue proof ${i + 1} failed to verify`)
    clueProofs.push({ guess, clue, proof, publicSignals, verified })
    if (isAllGreen(clue)) {
      solvedAt = i + 1
      break
    }
  }

  // On a win, produce + verify the permissionless settlement proof (sequence binding + dictionary).
  let solveProof: WordleSolveProof | undefined
  if (solvedAt > 0) {
    if (maxGuesses !== WORDLE_SOLVE_MAX_GUESSES) {
      throw new Error(`wordle: settlement proof only supports maxGuesses=${WORDLE_SOLVE_MAX_GUESSES}`)
    }
    const dict = params.dict ?? (await defaultDict())
    const committed = [...params.guesses]
    while (committed.length < maxGuesses) committed.push(WORDLE_FILLER)

    const solveSetup = setupFor('wordle_solve')
    const input = await buildWordleSolveWitnessInput({
      word: params.word,
      salt: params.salt,
      guesses: committed,
      dict,
      maxGuesses,
    })
    // sanity: the JS guess-commitment matches what the circuit will bind (public signal 1)
    const gc = await computeGuessesCommit(committed, maxGuesses)
    if (gc.toString() !== input.guessesCommit) throw new Error('wordle: guessesCommit mismatch')

    const { proof, publicSignals } = await prove(solveSetup, input)
    const verified = await verify(solveSetup, publicSignals, proof)
    if (!verified) throw new Error('wordle: settlement (solve) proof failed to verify')
    // public-signal order is [commit, guessesCommit, dictRoot, guessesUsed] (no public outputs)
    const provenGuessesUsed = Number(publicSignals[3])
    if (provenGuessesUsed !== solvedAt) {
      throw new Error(`wordle: proven guessesUsed ${provenGuessesUsed} != observed ${solvedAt}`)
    }
    solveProof = {
      proof,
      publicSignals,
      verified,
      guessesUsed: provenGuessesUsed,
      guessesCommit: input.guessesCommit,
      dictRoot: input.dictRoot,
    }
  }

  const wordleParams: WordleParams = { maxGuesses }
  const result: WordleResult = { solved: solvedAt > 0, guessesUsed: solvedAt || params.guesses.length }
  const outcome = wordle.settleRound(params.stake, wordleParams, result)
  return { clueProofs, solveProof, result, outcome }
}

export interface SudokuRoundResult {
  /**
   * The player's solve proof, bound to `player` via the nullifier (publicSignals[0]) — exactly the
   * calldata SudokuLog.logSolve verifies. ANY valid solution to the public puzzle proves out.
   */
  proof: unknown
  publicSignals: string[]
  nullifier: string
  verified: boolean
  /** The on-chain leaderboard entry SudokuLog would emit (`Solved`) for this solve. */
  entry: SudokuSolveEntry
}

/**
 * Play one ZK-Sudoku speedrun solve — the off-chain twin of SudokuLog.sol, a TIMED LEADERBOARD rather
 * than a wager (see @msgboard/games/games/sudoku for why a flat-multiplier bet on a public,
 * trivially-automatable solve is strictly -EV for the house and unmeasurable by the proof). The house
 * has already published the puzzle at `openedAt` (SudokuLog.openPuzzle); here the PLAYER proves they
 * know a VALID solution to that SAME public puzzle (sudoku_solve.circom), bound to their OWN `player`
 * address via the nullifier — NOT to any house secret. A verifying proof yields the on-chain `Solved`
 * leaderboard entry with the elapsed solve time (`solvedAt - openedAt`); `player` binds the proof, so a
 * mempool watcher cannot copy someone else's solve and re-log it under their own address.
 *
 * There is no house solvability proof (SudokuLog does not require one): with nothing escrowed, an
 * unsolvable board grieves no one — a player who cannot solve it simply never logs an entry.
 */
export async function playSudokuRound(params: {
  puzzle: number[]
  solution: number[]
  player: bigint
  puzzleId: bigint
  /** block timestamp the house published the puzzle at (SudokuLog.openPuzzle) — the leaderboard start */
  openedAt: bigint
  /** block timestamp the solve is logged at (SudokuLog.logSolve) — the leaderboard finish */
  solvedAt: bigint
}): Promise<SudokuRoundResult> {
  const setup = setupFor('sudoku_solve')

  // The player proves a valid solution to the public puzzle, bound to `player` via the nullifier.
  const input = await buildSudokuWitnessInput({
    puzzle: params.puzzle,
    solution: params.solution,
    player: params.player,
  })
  const { proof, publicSignals } = await prove(setup, input)
  const verified = await verify(setup, publicSignals, proof)
  if (!verified) throw new Error('sudoku: solve proof failed to verify')

  const nullifier = publicSignals[0]!
  const entry: SudokuSolveEntry = {
    puzzleId: params.puzzleId,
    player: params.player,
    nullifier: BigInt(nullifier),
    solvedAt: params.solvedAt,
    elapsed: sudokuElapsed(params.openedAt, params.solvedAt),
  }
  return { proof, publicSignals, nullifier, verified, entry }
}
