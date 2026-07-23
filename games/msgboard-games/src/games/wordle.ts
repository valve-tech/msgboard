import { type SkillGame, type SkillOutcome, skillOutcome } from '../skill'

/**
 * ZK-Wordle (gameId 30) — the house hides a 5-letter word behind a commitment and proves every
 * colour clue honest (see @msgboard/zk-skill circuits/wordle_clue.circom + contracts/zk/WordleRules.sol).
 * The player wins a payout scaled by how FEW guesses the solve took; miss all six → loss (and the
 * house reveals word+salt so the loss is auditable against the commitment).
 *
 * Payout is a PUBLISHED curve, not a hidden edge: a strong player who solves in 1–3 wins; the typical
 * solver (the reference distribution below) gets a partial refund; a slow/failed solver loses. The
 * curve is tuned so the *average player* returns < 1× stake (a real house edge) while skill is still
 * rewarded. On-chain mirror: SkillPayouts.wordleMultX100.
 */

export const WORDLE_GAME_ID = 30
export const WORDLE_MAX_GUESSES = 6

/**
 * Payout multiplier (×100) by guesses-used [1..6]; index 0 is unused. Fast solves pay a premium;
 * the modal 4-guess solve returns 0.80×; slow solves return a fraction; a 6-guess solve returns
 * 0.25×. A miss (index > 6 / not solved) pays 0. These are the escrow-relevant numbers — the largest
 * (solve-in-1) is the escrow ceiling.
 */
export const WORDLE_MULT_X100: readonly bigint[] = [
  0n, // [0] unused
  2500n, // 1 guess  → 25.00×
  350n, //  2 guesses →  3.50×
  130n, //  3 guesses →  1.30×
  80n, //   4 guesses →  0.80×
  55n, //   5 guesses →  0.55×
  25n, //   6 guesses →  0.25×
]

/**
 * PUBLISHED reference "average player" solve distribution (integer weights over 1000 rounds): how
 * often an average player solves in n guesses, plus a fail bucket. This is the assumption the house
 * edge is quoted against — it is documentation, not a probability the contract enforces. A skilled
 * player can beat it (that is the point of a skill game); the guarantee is only that under THIS
 * distribution the house is not player-favourable (asserted in test/skillGames.test.ts via rtpBps).
 */
export const WORDLE_REFERENCE_WEIGHTS: { guesses: number; weight: bigint }[] = [
  { guesses: 1, weight: 5n },
  { guesses: 2, weight: 40n },
  { guesses: 3, weight: 180n },
  { guesses: 4, weight: 340n },
  { guesses: 5, weight: 250n },
  { guesses: 6, weight: 150n },
  { guesses: 0, weight: 35n }, // 0 == did not solve (loss)
]

export interface WordleParams {
  /** max guesses allowed; fixed at 6 (kept explicit so the escrow ceiling is a pure function of params). */
  maxGuesses: number
}

/** The verified round summary: did the player reach all-green, and in how many guesses. */
export interface WordleResult {
  solved: boolean
  /** guesses used to reach the solve, 1..maxGuesses. Ignored when `solved` is false. */
  guessesUsed: number
}

/** payout multiplier (×100) for a result — 0 unless solved within [1, maxGuesses]. */
export function wordleMultiplierX100(result: WordleResult, maxGuesses = WORDLE_MAX_GUESSES): bigint {
  if (!result.solved) return 0n
  const g = result.guessesUsed
  if (!Number.isInteger(g) || g < 1 || g > maxGuesses) throw new Error('wordle: guessesUsed out of range')
  return WORDLE_MULT_X100[g]!
}

export const wordle: SkillGame<WordleParams, WordleResult> = {
  gameId: WORDLE_GAME_ID,
  maxMultiplierX100(params): bigint {
    if (params.maxGuesses !== WORDLE_MAX_GUESSES) throw new Error('wordle: only maxGuesses=6 is supported')
    // solve-in-1 is the richest payout and thus the escrow ceiling.
    return WORDLE_MULT_X100[1]!
  },
  settleRound(stake, params, result): SkillOutcome {
    if (params.maxGuesses !== WORDLE_MAX_GUESSES) throw new Error('wordle: only maxGuesses=6 is supported')
    return skillOutcome(stake, wordleMultiplierX100(result, params.maxGuesses))
  },
}
