import { type Hex } from 'viem'
import { subRandom } from '../rng'
import {
  compoundFairEdgedX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * GREED DICE (gameId 19) — push-your-luck on the shared ladder engine. Re-roll a die to grow the
 * multiplier; roll a bad face and you bust; bank (cash out) any time. The first `bustFaces` of 6 faces
 * bust; surviving multiplies the running prize by the fair factor 6/(6-bustFaces). Each roll's face is
 * DERIVED from the sealed seed (`subRandom(seed, roll)`), so it is provably fair. Mechanically a
 * survival ladder (like Chicken) with a 6-face die and a constant per-roll bust probability.
 */
export const GREED_DICE_GAME_ID = 19 as const

export interface GreedDiceConfig {
  /** max rolls (ladder height). */
  rolls: number
  /** number of the 6 faces that bust, in [1,5]. */
  bustFaces: number
}

const FACES = 6
const MIN_ROLLS = 1
const MAX_ROLLS = 20

export function validateGreedDiceConfig(c: GreedDiceConfig): void {
  if (!Number.isInteger(c.rolls) || c.rolls < MIN_ROLLS || c.rolls > MAX_ROLLS) {
    throw new Error(`greed-dice: rolls out of range [${MIN_ROLLS},${MAX_ROLLS}]`)
  }
  if (!Number.isInteger(c.bustFaces) || c.bustFaces < 1 || c.bustFaces > FACES - 1) {
    throw new Error('greed-dice: bustFaces out of range [1,5]')
  }
}

/** the die face rolled at a step, 0..5 (0 == "1 pip"). */
export function faceAt(seed: bigint, roll: number): number {
  return Number(subRandom(seed, BigInt(roll)) % BigInt(FACES))
}

/** survives the roll iff the face is not in the bust set (the first `bustFaces` faces bust). */
export function rollSurvives(seed: bigint, config: GreedDiceConfig, roll: number): boolean {
  return faceAt(seed, roll) >= config.bustFaces
}

/** Running edged multiplier after `rollsSurvived` good rolls. 100 at k=0. */
export function greedDiceMultiplierX100(config: GreedDiceConfig, rollsSurvived: number): bigint {
  return compoundFairEdgedX100(FACES, FACES - config.bustFaces, rollsSurvived)
}

/** Escrow ceiling: surviving every roll. */
export function greedDiceMaxMultiplierX100(config: GreedDiceConfig): bigint {
  validateGreedDiceConfig(config)
  return greedDiceMultiplierX100(config, config.rolls)
}

export function greedDiceResolveStep(seed: bigint, config: GreedDiceConfig) {
  return (roll: number, _choice: number): StepOutcome => ({
    safe: rollSurvives(seed, config, roll),
    multiplierX100: greedDiceMultiplierX100(config, roll + 1),
  })
}

export function startGreedDice(config: GreedDiceConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateGreedDiceConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.rolls), commit }
}

export { ladderAdvance as greedDiceAdvance, ladderCashOut as greedDiceCashOut, ladderPlayerDelta as greedDicePlayerDelta }

export function verifyGreedDice(claim: LadderClaim, seed: bigint, config: GreedDiceConfig): LadderVerdict {
  const resolve = greedDiceResolveStep(seed, config)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
