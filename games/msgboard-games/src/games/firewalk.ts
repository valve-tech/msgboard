import { type Hex } from 'viem'
import { subRandom } from '../rng'
import { HUNDREDTHS } from '../game'
import {
  applyLadderEdgeX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * FIREWALK (gameId 16) — walk a path of hot tiles on the shared ladder engine. Like Chicken, but the
 * burn probability ESCALATES each step, so the multiplier curve steepens as you go. Each tile is safe
 * unless the sealed seed lands in that tile's (growing) burn region; one burn busts; cash out any time.
 * Per-tile burn = min(BASE + step, OUTCOMES-1) of OUTCOMES, DERIVED from `subRandom(seed, step)` —
 * provably fair. Because the factor varies per step, the running fair multiplier is the rational
 * product Π OUTCOMES/(OUTCOMES - burn_i), edged once.
 */
export const FIREWALK_GAME_ID = 16 as const

export interface FirewalkConfig {
  /** number of tiles to attempt (ladder height). */
  tiles: number
}

const OUTCOMES = 25
const BASE_BURN = 2 // step 0 burns 2/25 (8%); +1 each step
const MIN_TILES = 1
const MAX_TILES = 12

export function validateFirewalkConfig(c: FirewalkConfig): void {
  if (!Number.isInteger(c.tiles) || c.tiles < MIN_TILES || c.tiles > MAX_TILES) {
    throw new Error(`firewalk: tiles out of range [${MIN_TILES},${MAX_TILES}]`)
  }
}

/** burn count (of OUTCOMES) at a tile index — escalates by 1 per step, capped below OUTCOMES. */
export function burnAt(step: number): number {
  return Math.min(BASE_BURN + step, OUTCOMES - 1)
}

/** Is the tile safe? The first `burnAt(step)` outcomes are the burn region. */
export function tileSafe(seed: bigint, step: number): boolean {
  return Number(subRandom(seed, BigInt(step)) % BigInt(OUTCOMES)) >= burnAt(step)
}

/** Running edged multiplier after `tilesWalked` safe tiles: edged(Π OUTCOMES/(OUTCOMES-burn_i)). */
export function firewalkMultiplierX100(tilesWalked: number): bigint {
  let num = 1n
  let den = 1n
  for (let i = 0; i < tilesWalked; i++) {
    num *= BigInt(OUTCOMES)
    den *= BigInt(OUTCOMES - burnAt(i))
  }
  return applyLadderEdgeX100((num * HUNDREDTHS) / den)
}

/** Escrow ceiling: walking every tile. */
export function firewalkMaxMultiplierX100(config: FirewalkConfig): bigint {
  validateFirewalkConfig(config)
  return firewalkMultiplierX100(config.tiles)
}

export function firewalkResolveStep(seed: bigint) {
  return (step: number, _choice: number): StepOutcome => ({
    safe: tileSafe(seed, step),
    multiplierX100: firewalkMultiplierX100(step + 1),
  })
}

export function startFirewalk(config: FirewalkConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateFirewalkConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.tiles), commit }
}

export { ladderAdvance as firewalkAdvance, ladderCashOut as firewalkCashOut, ladderPlayerDelta as firewalkPlayerDelta }

export function verifyFirewalk(claim: LadderClaim, seed: bigint): LadderVerdict {
  const resolve = firewalkResolveStep(seed)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
