import { type Hex } from 'viem'
import { subRandom } from '../rng'
import {
  compoundFairEdgedX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * CIPHER (gameId 26) — OUR take on morbius's laddered code-cracking game, on the shared ladder engine.
 * Climb a sequence of `rungs`; on each rung guess ONE of `symbols` positions (the "code digit"), exactly
 * one of which is correct. A correct guess advances and multiplies the running prize; a wrong guess busts
 * ("the alarm trips"). Cash out any time. The correct digit on each rung is DERIVED from the sealed round
 * seed (`subRandom(seed, rung) % symbols`), never house-placed — so the ladder is provably fair, exactly
 * the Towers/Firewalk trust model.
 *
 * DIFFICULTY sets `symbols` (how many positions to choose among): the more symbols the harder each rung
 * and the steeper the reward. Per-rung fair factor = symbols/1 (a 1-in-`symbols` guess), so the running
 * fair multiplier after k rungs is symbols^k, edged once (the standard 1% ladder edge).
 */
export const CIPHER_GAME_ID = 26 as const

export type CipherDifficulty = 'easy' | 'medium' | 'hard' | 'expert'

/** symbols-per-rung by difficulty (the size of the guess space on every rung). */
export const CIPHER_SYMBOLS: Record<CipherDifficulty, number> = {
  easy: 2,
  medium: 3,
  hard: 4,
  expert: 5,
}

export interface CipherConfig {
  /** number of rungs to attempt (ladder height). */
  rungs: number
  difficulty: CipherDifficulty
}

const MIN_RUNGS = 1
const MAX_RUNGS = 32

export function cipherSymbols(difficulty: CipherDifficulty): number {
  const s = CIPHER_SYMBOLS[difficulty]
  if (s === undefined) throw new Error(`cipher: unknown difficulty ${difficulty}`)
  return s
}

export function validateCipherConfig(c: CipherConfig): void {
  cipherSymbols(c.difficulty) // validates difficulty
  if (!Number.isInteger(c.rungs) || c.rungs < MIN_RUNGS || c.rungs > MAX_RUNGS) {
    throw new Error(`cipher: rungs out of range [${MIN_RUNGS},${MAX_RUNGS}]`)
  }
}

/** The correct code digit on a rung, in [0, symbols-1], derived from the sealed seed. */
export function cipherDigit(seed: bigint, difficulty: CipherDifficulty, rung: number): number {
  const N = cipherSymbols(difficulty)
  return Number(subRandom(seed, BigInt(rung)) % BigInt(N))
}

/** Running edged multiplier (hundredths) after `rungsCracked` correct guesses: edged(symbols^k). 100 at k=0. */
export function cipherMultiplierX100(config: CipherConfig, rungsCracked: number): bigint {
  return compoundFairEdgedX100(cipherSymbols(config.difficulty), 1, rungsCracked)
}

/** Escrow ceiling: cracking every rung. */
export function cipherMaxMultiplierX100(config: CipherConfig): bigint {
  validateCipherConfig(config)
  return cipherMultiplierX100(config, config.rungs)
}

/** The per-step resolver for the shared engine: is `guess` the correct digit on `rung`? */
export function cipherResolveStep(seed: bigint, config: CipherConfig) {
  return (rung: number, guess: number): StepOutcome => ({
    safe: guess === cipherDigit(seed, config.difficulty, rung),
    multiplierX100: cipherMultiplierX100(config, rung + 1),
  })
}

/** Start a Cipher session: commit to the code seed and open the ladder at the configured height. */
export function startCipher(config: CipherConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateCipherConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.rungs), commit }
}

export { ladderAdvance as cipherAdvance, ladderCashOut as cipherCashOut, ladderPlayerDelta as cipherPlayerDelta }

/** Adjudicate a disputed Cipher session by replaying guesses through the seed-derived code. */
export function verifyCipher(claim: LadderClaim, seed: bigint, config: CipherConfig): LadderVerdict {
  const resolve = cipherResolveStep(seed, config)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
