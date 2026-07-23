import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { subRandom } from '../rng'

/**
 * Dice X2 — two independent roll-unders from one round. The player commits a roll-under `target` and a
 * `mode` at OPEN; the round derives TWO independent rolls from `raw` via `subRandom(raw, 0|1)`.
 *   - mode 'both'  : win iff BOTH rolls are under target (harder, pays more).
 *   - mode 'either': win iff AT LEAST ONE roll is under target (easier, pays less).
 * The multiplier is the single (1-edge)/winChance for the combined event, so a win has no variance and
 * the escrow ceiling equals that multiplier. Pure single-draw (P1) over a derived two-roll space —
 * still fully recompute-settle and provably fair (both sub-rolls fixed the instant `raw` is).
 */
export type DiceX2Mode = 'both' | 'either'

export interface DiceX2Params {
  /** roll-under target in hundredths of a percent: 50.00% == 5000. Range [100, 9899]. */
  targetX100: bigint
  /** combine rule for the two rolls. */
  mode: DiceX2Mode
}

const ROLL_SPACE = 10_000n // each roll is 0..9999 (0.00%..99.99%)
const MIN_TARGET = 100n    // 1.00%; keeps the 'both' multiplier from exploding
const MAX_TARGET = 9899n   // mirror dice's cap (finite, below the display ceiling)
// NUM = (1-edge)*ROLL_SPACE*HUNDREDTHS, the numerator of multX100 = NUM / winCountScaled.
const NUM = (ROLL_SPACE - EDGE_BPS) * ROLL_SPACE * HUNDREDTHS // 9_900_000_000

/** the two independent rolls in [0, 9999] for this round. */
export function diceX2Rolls(raw: bigint): [bigint, bigint] {
  return [subRandom(raw, 0n) % ROLL_SPACE, subRandom(raw, 1n) % ROLL_SPACE]
}

/**
 * Number of winning (roll1, roll2) pairs out of ROLL_SPACE^2 for a (target, mode) — i.e. winChance
 * scaled by ROLL_SPACE^2. 'both' = target^2; 'either' = ROLL_SPACE^2 - (ROLL_SPACE - target)^2.
 */
export function diceX2WinCountScaled(targetX100: bigint, mode: DiceX2Mode): bigint {
  if (mode === 'both') return targetX100 * targetX100
  const miss = ROLL_SPACE - targetX100
  return ROLL_SPACE * ROLL_SPACE - miss * miss // 2*ROLL_SPACE*target - target^2
}

/** payout multiplier (hundredths): (1-edge)/winChance == NUM / winCountScaled. */
export function diceX2MultiplierX100(targetX100: bigint, mode: DiceX2Mode): bigint {
  return NUM / diceX2WinCountScaled(targetX100, mode)
}

function validate(params: DiceX2Params): void {
  if (params.targetX100 < MIN_TARGET || params.targetX100 > MAX_TARGET) throw new Error('dicex2: target out of range')
  if (params.mode !== 'both' && params.mode !== 'either') throw new Error('dicex2: bad mode')
}

function isWin(rolls: [bigint, bigint], targetX100: bigint, mode: DiceX2Mode): boolean {
  const [a, b] = rolls
  const aUnder = a < targetX100
  const bUnder = b < targetX100
  return mode === 'both' ? aUnder && bUnder : aUnder || bUnder
}

export const dicex2: Game<DiceX2Params> = {
  gameId: 10,
  maxMultiplierX100(params): bigint {
    // No payout variance — a win always pays exactly this, so it is also the escrow ceiling.
    validate(params)
    return diceX2MultiplierX100(params.targetX100, params.mode)
  },
  settleRound(stake, params, raw): RoundOutcome {
    validate(params)
    const win = isWin(diceX2Rolls(raw), params.targetX100, params.mode)
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const multiplierX100 = diceX2MultiplierX100(params.targetX100, params.mode)
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    const mode = params.mode === 'both' ? 0 : 1
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.targetX100, mode, raw],
    ) as Hex
  },
}
