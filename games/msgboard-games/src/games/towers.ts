import { type Hex } from 'viem'
import { subRandom } from '../rng'
import {
  compoundFairEdgedX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * TOWERS / Dragon Tower (gameId 14) — a ladder game on the shared engine. Climb `floors`; on each
 * floor pick 1 of `tilesPerFloor` tiles, `safePerFloor` of which are safe. A safe pick advances and
 * multiplies the running prize; an unsafe pick busts. Cash out any time. The safe set on each floor is
 * DERIVED from the sealed round seed (`subRandom(seed, floor)`), never house-placed — so it is
 * provably fair. Per-floor fair factor = tiles/safe; running fair after k floors = (T/S)^k, edged once.
 */
export const TOWERS_GAME_ID = 14 as const

export interface TowersConfig {
  floors: number
  tilesPerFloor: number
  safePerFloor: number
}

const MIN_FLOORS = 1
const MAX_FLOORS = 64
const MIN_TILES = 2
const MAX_TILES = 16

export function validateTowersConfig(c: TowersConfig): void {
  if (!Number.isInteger(c.floors) || c.floors < MIN_FLOORS || c.floors > MAX_FLOORS) {
    throw new Error(`towers: floors out of range [${MIN_FLOORS},${MAX_FLOORS}]`)
  }
  if (!Number.isInteger(c.tilesPerFloor) || c.tilesPerFloor < MIN_TILES || c.tilesPerFloor > MAX_TILES) {
    throw new Error(`towers: tilesPerFloor out of range [${MIN_TILES},${MAX_TILES}]`)
  }
  if (!Number.isInteger(c.safePerFloor) || c.safePerFloor < 1 || c.safePerFloor > c.tilesPerFloor - 1) {
    throw new Error('towers: safePerFloor out of range [1, tilesPerFloor-1]')
  }
}

/** The set of safe tile indices on a floor, derived from the floor's seed via a partial Fisher–Yates. */
export function safeTilesOnFloor(seed: bigint, config: TowersConfig, floor: number): Set<number> {
  const { tilesPerFloor: T, safePerFloor: S } = config
  const pool: number[] = Array.from({ length: T }, (_, i) => i)
  let r = subRandom(seed, BigInt(floor))
  const set = new Set<number>()
  for (let i = T - 1; i >= T - S; i--) {
    const window = BigInt(i + 1)
    const j = Number(r % window)
    r = r / window
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
    set.add(pool[i]!)
  }
  return set
}

/** Running edged multiplier in hundredths after `floorsClimbed` safe floors. 100 at k=0. */
export function towersMultiplierX100(config: TowersConfig, floorsClimbed: number): bigint {
  return compoundFairEdgedX100(config.tilesPerFloor, config.safePerFloor, floorsClimbed)
}

/** Escrow ceiling: the top-of-ladder multiplier (all floors climbed). */
export function towersMaxMultiplierX100(config: TowersConfig): bigint {
  validateTowersConfig(config)
  return towersMultiplierX100(config, config.floors)
}

/** The per-step resolver for the shared engine: is `tile` safe on `floor`, and the running multiplier. */
export function towersResolveStep(seed: bigint, config: TowersConfig) {
  return (floor: number, tile: number): StepOutcome => ({
    safe: safeTilesOnFloor(seed, config, floor).has(tile),
    multiplierX100: towersMultiplierX100(config, floor + 1),
  })
}

/** Start a Towers session: commit to the layout seed and open the ladder at the configured height. */
export function startTowers(config: TowersConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateTowersConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.floors), commit }
}

export { ladderAdvance as towersAdvance, ladderCashOut as towersCashOut, ladderPlayerDelta as towersPlayerDelta }

/** Adjudicate a disputed Towers session by replaying choices through the seed-derived layout. */
export function verifyTowers(claim: LadderClaim, seed: bigint, config: TowersConfig): LadderVerdict {
  const resolve = towersResolveStep(seed, config)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
