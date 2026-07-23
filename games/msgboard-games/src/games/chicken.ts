import { type Hex } from 'viem'
import { subRandom } from '../rng'
import {
  compoundFairEdgedX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * CHICKEN (gameId 15) — cross-the-road on the shared ladder engine. Each lane the player steps forward
 * (a single path, so the engine "choice" is always 0); the lane is safe unless the seed lands in the
 * crash region. Difficulty sets the per-lane crash probability `crash/OUTCOMES`. Survive to multiply;
 * one crash busts; cash out any time. The crash outcome per lane is DERIVED from the sealed seed
 * (`subRandom(seed, lane)`), so it is provably fair. Per-lane fair factor = OUTCOMES/(OUTCOMES-crash).
 * Structurally Towers with a single forced path (tilesPerLane folded into the probability).
 */
export const CHICKEN_GAME_ID = 15 as const

export type ChickenDifficulty = 'easy' | 'medium' | 'hard' | 'daredevil'

export interface ChickenConfig {
  difficulty: ChickenDifficulty
  /** number of lanes to attempt (ladder height). */
  lanes: number
}

const OUTCOMES = 25 // crash probability denominator
/** crashes per OUTCOMES for each difficulty (4%, 12%, 20%, 40%). */
const CRASH: Record<ChickenDifficulty, number> = { easy: 1, medium: 3, hard: 5, daredevil: 10 }
const MIN_LANES = 1
const MAX_LANES = 24

export function validateChickenConfig(c: ChickenConfig): void {
  if (!(c.difficulty in CRASH)) throw new Error('chicken: bad difficulty')
  if (!Number.isInteger(c.lanes) || c.lanes < MIN_LANES || c.lanes > MAX_LANES) {
    throw new Error(`chicken: lanes out of range [${MIN_LANES},${MAX_LANES}]`)
  }
}

/** Is the lane safe? The first `crash` outcomes of OUTCOMES are the crash region. */
export function laneSafe(seed: bigint, difficulty: ChickenDifficulty, lane: number): boolean {
  return Number(subRandom(seed, BigInt(lane)) % BigInt(OUTCOMES)) >= CRASH[difficulty]
}

/** Running edged multiplier after `lanesCrossed` safe lanes. 100 at k=0. */
export function chickenMultiplierX100(difficulty: ChickenDifficulty, lanesCrossed: number): bigint {
  const safe = OUTCOMES - CRASH[difficulty]
  return compoundFairEdgedX100(OUTCOMES, safe, lanesCrossed)
}

/** Escrow ceiling: crossing every lane. */
export function chickenMaxMultiplierX100(config: ChickenConfig): bigint {
  validateChickenConfig(config)
  return chickenMultiplierX100(config.difficulty, config.lanes)
}

export function chickenResolveStep(seed: bigint, config: ChickenConfig) {
  return (lane: number, _choice: number): StepOutcome => ({
    safe: laneSafe(seed, config.difficulty, lane),
    multiplierX100: chickenMultiplierX100(config.difficulty, lane + 1),
  })
}

export function startChicken(config: ChickenConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateChickenConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.lanes), commit }
}

export { ladderAdvance as chickenAdvance, ladderCashOut as chickenCashOut, ladderPlayerDelta as chickenPlayerDelta }

export function verifyChicken(claim: LadderClaim, seed: bigint, config: ChickenConfig): LadderVerdict {
  const resolve = chickenResolveStep(seed, config)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
