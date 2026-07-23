import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'

export interface DiceParams {
  /** roll-under target in hundredths of a percent: 54.50% == 5450. Range [1, 9899]. */
  targetX100: bigint
}

const ROLL_SPACE = 10_000n // rolls are 0..9999, i.e. 0.00%..99.99%
const MIN_TARGET = 1n
const MAX_TARGET = 9899n // keep multiplier finite and below the 100x display ceiling

/** roll in [0, 9999], representing 0.00%..99.99%. */
export function diceRoll(raw: bigint): bigint {
  return raw % ROLL_SPACE
}

/** multiplier in hundredths: floor((100% - edge) / winChance). 99_000_000 = (10000-100)*10000. */
export function diceMultiplierX100(targetX100: bigint): bigint {
  return (ROLL_SPACE - EDGE_BPS) * ROLL_SPACE / targetX100 / HUNDREDTHS
}

export const dice: Game<DiceParams> = {
  gameId: 1,
  maxMultiplierX100(params): bigint {
    // No payout variance — every win pays exactly this, so it is also the escrow ceiling.
    if (params.targetX100 < MIN_TARGET || params.targetX100 > MAX_TARGET) throw new Error('dice: target out of range')
    return diceMultiplierX100(params.targetX100)
  },
  settleRound(stake, params, raw): RoundOutcome {
    if (params.targetX100 < MIN_TARGET || params.targetX100 > MAX_TARGET) throw new Error('dice: target out of range')
    const roll = diceRoll(raw)
    const win = roll < params.targetX100
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const multiplierX100 = diceMultiplierX100(params.targetX100)
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.targetX100, raw],
    ) as Hex
  },
}
