import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'

export interface LimboParams {
  /** target multiplier in hundredths: 5.00x == 500. Range [100 (1.00x), 99_000_000 (990000.00x)]. */
  targetX100: bigint
}

const U_SPACE = 1_000_000n // u in [0, 999_999] models U in [0,1) at 1e-6 resolution
// (1 - edge) expressed in hundredths: (10000 - 100)/100 = 99  (i.e. 0.99x == 99).
const ONE_MINUS_EDGE_X100 = (10_000n - EDGE_BPS) / HUNDREDTHS // 99n
const MIN_TARGET = 100n              // 1.00x
// Max meaningful target == the largest result limboResultX100 can return (u = U_SPACE-1):
// ONE_MINUS_EDGE_X100 * U_SPACE == 99_000_000 (990000.00x). Above this, no roll can ever win.
const MAX_TARGET = ONE_MINUS_EDGE_X100 * U_SPACE // 99_000_000n

/** result multiplier in hundredths: (1-edge)/(1-U) == 99_000_000 / (1e6 - u). */
export function limboResultX100(u: bigint): bigint {
  return (ONE_MINUS_EDGE_X100 * U_SPACE) / (U_SPACE - u)
}

/** win chance in hundredths of a percent: (1-edge)/target == 990000 / targetX100. */
export function limboWinChanceX100(targetX100: bigint): bigint {
  // P(result >= target) = (1-edge)/target ; as hundredths-of-a-percent (100% == 10000):
  // ONE_MINUS_EDGE_X100 * 10000 / targetX100  ==  99 * 10000 / 500 == 1980 for a 5x target.
  return (ONE_MINUS_EDGE_X100 * 10_000n) / targetX100
}

export const limbo: Game<LimboParams> = {
  gameId: 2,
  maxMultiplierX100(params): bigint {
    // Every win pays the player's chosen target multiplier exactly — that IS the ceiling.
    if (params.targetX100 < MIN_TARGET || params.targetX100 > MAX_TARGET) throw new Error('limbo: target out of range')
    return params.targetX100
  },
  settleRound(stake, params, raw): RoundOutcome {
    if (params.targetX100 < MIN_TARGET) throw new Error('limbo: target below 1.00x')
    if (params.targetX100 > MAX_TARGET) throw new Error('limbo: target above max (990000.00x)')
    const u = raw % U_SPACE
    const resultX100 = limboResultX100(u)
    const win = resultX100 >= params.targetX100
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const playerDelta = (stake * params.targetX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100: params.targetX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [this.gameId, stake, params.targetX100, raw],
    )
  },
}
