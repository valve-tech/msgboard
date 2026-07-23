import { type Hex } from 'viem'
import { HUNDREDTHS } from '../game'
import { rankOf, shuffleDeck } from '../cards'
import {
  applyLadderEdgeX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * HI-LO (gameId 18) — a card ladder on the shared engine. A card is shown; guess whether the next is
 * HIGHER-or-same (choice 0) or LOWER-or-same (choice 1). A correct guess chains a per-step multiplier
 * = edged(1/P) priced from the current card's rank; a wrong guess busts; cash out any time. Cards come
 * from a deck shuffled off the sealed seed — provably fair. Each guess is an independent 1%-edge bet,
 * so the running multiplier compounds (edge per step, the standard hi-lo model), CAPPED at `capX100`
 * to bound the house's escrow (the cap is the escrow ceiling).
 *
 * Pricing is the memoryless single-card model (the accepted provably-fair convention): for current
 * rank r, of the other 51 cards `4*(15-r)-1` are >= r and `4*(r-1)-1` are <= r (ties count for the
 * chosen side). P = count/51, step multiplier = edged(51*100/count).
 */
export const HILO_GAME_ID = 18 as const

export interface HiLoConfig {
  /** max guesses (ladder height); reaching it forces a cash-out. */
  steps: number
  /** running-multiplier cap in hundredths — the escrow ceiling. The multiplier never exceeds this. */
  capX100: bigint
}

const MIN_STEPS = 1
const MAX_STEPS = 25
export const HILO_HIGHER = 0
export const HILO_LOWER = 1

export function validateHiLoConfig(c: HiLoConfig): void {
  if (!Number.isInteger(c.steps) || c.steps < MIN_STEPS || c.steps > MAX_STEPS) {
    throw new Error(`hilo: steps out of range [${MIN_STEPS},${MAX_STEPS}]`)
  }
  if (c.capX100 < HUNDREDTHS) throw new Error('hilo: capX100 must be >= 1.00x')
}

/** count of the other 51 cards satisfying the guess for current rank r (ties count for the side). */
function favorableCount(currentRank: number, choice: number): number {
  return choice === HILO_HIGHER ? 4 * (15 - currentRank) - 1 : 4 * (currentRank - 1) - 1
}

/** per-step edged multiplier for guessing `choice` on a card of rank `currentRank`. */
export function hiloStepMultiplierX100(currentRank: number, choice: number): bigint {
  const count = favorableCount(currentRank, choice)
  if (count <= 0) return 0n // impossible guess (e.g. "higher" on an ace) — pays nothing, always wrong
  return applyLadderEdgeX100((51n * HUNDREDTHS) / BigInt(count))
}

/** the per-step resolver: reads deck[step] (current) and deck[step+1] (next) from the seed-shuffled deck. */
export function hiloResolveStep(seed: bigint, config: HiLoConfig) {
  const deck = shuffleDeck(seed)
  return (step: number, choice: number, currentMultiplierX100: bigint): StepOutcome => {
    const currentRank = rankOf(deck[step]!)
    const nextRank = rankOf(deck[step + 1]!)
    const correct = choice === HILO_HIGHER ? nextRank >= currentRank : nextRank <= currentRank
    if (!correct) return { safe: false, multiplierX100: 0n }
    const stepMult = hiloStepMultiplierX100(currentRank, choice)
    let next = (currentMultiplierX100 * stepMult) / HUNDREDTHS
    if (next > config.capX100) next = config.capX100 // clamp to the escrow ceiling
    return { safe: true, multiplierX100: next }
  }
}

/** Escrow ceiling: the configured cap. */
export function hiloMaxMultiplierX100(config: HiLoConfig): bigint {
  validateHiLoConfig(config)
  return config.capX100
}

export function startHiLo(config: HiLoConfig, seed: bigint): { state: LadderState; commit: Hex; firstCard: number } {
  validateHiLoConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.steps), commit, firstCard: shuffleDeck(seed)[0]! }
}

export { ladderAdvance as hiloAdvance, ladderCashOut as hiloCashOut, ladderPlayerDelta as hiloPlayerDelta }

export function verifyHiLo(claim: LadderClaim, seed: bigint, config: HiLoConfig): LadderVerdict {
  return verifyLadder(claim, seed, hiloResolveStep(seed, config))
}
