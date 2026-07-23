import { type Hex } from 'viem'
import { subRandom } from '../rng'
import { HUNDREDTHS } from '../game'
import {
  applyLadderEdgeX100, commitLayout, startLadder, ladderAdvance, ladderCashOut, ladderPlayerDelta,
  verifyLadder, type LadderState, type StepOutcome, type LadderClaim, type LadderVerdict,
} from '../ladder'

/**
 * HEIST (gameId 17) — crack a string of vaults on the shared ladder engine. Each room has `vaults`
 * positions; some are alarms. Pick a vault: a clean vault advances and multiplies the loot, an alarm
 * busts the job. The danger ESCALATES — deeper rooms post more guards (alarms grow per room) — so the
 * per-room factor varies, and the running fair multiplier is the rational product Π vaults/(vaults -
 * alarms_i), edged once. Alarm positions per room are DERIVED from the sealed seed (a partial
 * Fisher–Yates over the vaults), never house-placed, so the layout is provably fair. Cash out (escape)
 * any time. (A future enhancement: per-vault varied loot, mean-preserved — out of scope here.)
 */
export const HEIST_GAME_ID = 17 as const

export interface HeistConfig {
  /** number of rooms to attempt (ladder height). */
  rooms: number
  /** vaults per room. */
  vaults: number
  /** alarms in the first room; grows by 1 each room (capped at vaults-1). */
  baseAlarms: number
}

const MIN_ROOMS = 1
const MAX_ROOMS = 32
const MIN_VAULTS = 2
const MAX_VAULTS = 16

export function validateHeistConfig(c: HeistConfig): void {
  if (!Number.isInteger(c.rooms) || c.rooms < MIN_ROOMS || c.rooms > MAX_ROOMS) {
    throw new Error(`heist: rooms out of range [${MIN_ROOMS},${MAX_ROOMS}]`)
  }
  if (!Number.isInteger(c.vaults) || c.vaults < MIN_VAULTS || c.vaults > MAX_VAULTS) {
    throw new Error(`heist: vaults out of range [${MIN_VAULTS},${MAX_VAULTS}]`)
  }
  if (!Number.isInteger(c.baseAlarms) || c.baseAlarms < 1 || c.baseAlarms > c.vaults - 1) {
    throw new Error('heist: baseAlarms out of range [1, vaults-1]')
  }
  // the last room must still leave one safe vault
  if (alarmsAt(c, c.rooms - 1) > c.vaults - 1) throw new Error('heist: escalation leaves no safe vault')
}

/** alarms in a room — escalates by 1 per room, capped at vaults-1. */
export function alarmsAt(config: HeistConfig, room: number): number {
  return Math.min(config.baseAlarms + room, config.vaults - 1)
}

/** The set of alarm positions in a room, derived from the room's seed via a partial Fisher–Yates. */
export function alarmPositions(seed: bigint, config: HeistConfig, room: number): Set<number> {
  const V = config.vaults
  const A = alarmsAt(config, room)
  const pool: number[] = Array.from({ length: V }, (_, i) => i)
  let r = subRandom(seed, BigInt(room))
  const set = new Set<number>()
  for (let i = V - 1; i >= V - A; i--) {
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

/** Running edged multiplier after `roomsCracked` clean rooms: edged(Π vaults/(vaults-alarms_i)). */
export function heistMultiplierX100(config: HeistConfig, roomsCracked: number): bigint {
  let num = 1n
  let den = 1n
  for (let i = 0; i < roomsCracked; i++) {
    num *= BigInt(config.vaults)
    den *= BigInt(config.vaults - alarmsAt(config, i))
  }
  return applyLadderEdgeX100((num * HUNDREDTHS) / den)
}

/** Escrow ceiling: cracking every room. */
export function heistMaxMultiplierX100(config: HeistConfig): bigint {
  validateHeistConfig(config)
  return heistMultiplierX100(config, config.rooms)
}

export function heistResolveStep(seed: bigint, config: HeistConfig) {
  return (room: number, vault: number): StepOutcome => ({
    safe: !alarmPositions(seed, config, room).has(vault),
    multiplierX100: heistMultiplierX100(config, room + 1),
  })
}

export function startHeist(config: HeistConfig, seed: bigint): { state: LadderState; commit: Hex } {
  validateHeistConfig(config)
  const commit = commitLayout(seed)
  return { state: startLadder(commit, config.rooms), commit }
}

export { ladderAdvance as heistAdvance, ladderCashOut as heistCashOut, ladderPlayerDelta as heistPlayerDelta }

export function verifyHeist(claim: LadderClaim, seed: bigint, config: HeistConfig): LadderVerdict {
  const resolve = heistResolveStep(seed, config)
  return verifyLadder(claim, seed, (i, choice) => resolve(i, choice))
}
