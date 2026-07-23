import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { subRandom } from '../rng'

/**
 * Craps — pass / don't-pass line. Decisionless: once the bet is placed the whole roll sequence is
 * determined by the sealed seed, so it rides the single-draw rails (no co-sign needed). Each roll's two
 * dice come from `subRandom(raw, …)`, so the entire shoot is recomputable from the committed two-sided
 * seed — provably fair. Come-out 7/11 wins the pass line and 2/3/12 loses it; otherwise the number is
 * the POINT and the shooter rolls until the point (pass wins) or a 7 (pass loses). Don't-pass is the
 * mirror, with 12 BARRED (push). Both pay 1:1; the structural edge is the come-out asymmetry + bar-12.
 */
export type CrapsBet = 'pass' | 'dontpass'

export interface CrapsParams {
  bet: CrapsBet
}

export type CrapsResult = 'win' | 'lose' | 'push'

const PAYOUT_X100 = 200n // 1:1
const MAX_ROLLS = 256 // a 7-or-point is hit within a handful of rolls a.s.; this cap is a safety net.

/** the two dice (1..6 each) for roll index k of this shoot. */
export function crapsRoll(raw: bigint, k: number): [number, number] {
  const d1 = Number(subRandom(raw, BigInt(2 * k)) % 6n) + 1
  const d2 = Number(subRandom(raw, BigInt(2 * k + 1)) % 6n) + 1
  return [d1, d2]
}

/** Resolve the shoot for a bet: the full roll list, the point (or null), and the player result. */
export function resolveCraps(raw: bigint, bet: CrapsBet): { rolls: [number, number][]; point: number | null; result: CrapsResult } {
  const rolls: [number, number][] = []
  const comeOut = crapsRoll(raw, 0)
  rolls.push(comeOut)
  const co = comeOut[0] + comeOut[1]

  if (co === 7 || co === 11) return { rolls, point: null, result: bet === 'pass' ? 'win' : 'lose' }
  if (co === 2 || co === 3) return { rolls, point: null, result: bet === 'pass' ? 'lose' : 'win' }
  if (co === 12) return { rolls, point: null, result: bet === 'pass' ? 'lose' : 'push' } // bar 12 for don't-pass

  const point = co
  for (let k = 1; k < MAX_ROLLS; k++) {
    const r = crapsRoll(raw, k)
    rolls.push(r)
    const sum = r[0] + r[1]
    if (sum === point) return { rolls, point, result: bet === 'pass' ? 'win' : 'lose' }
    if (sum === 7) return { rolls, point, result: bet === 'pass' ? 'lose' : 'win' }
  }
  return { rolls, point, result: 'push' } // unreachable in practice
}

const betCode = (bet: CrapsBet): number => (bet === 'pass' ? 0 : 1)

export const craps: Game<CrapsParams> = {
  gameId: 20,
  maxMultiplierX100(): bigint {
    return PAYOUT_X100 // 1:1 either way
  },
  settleRound(stake, params, raw): RoundOutcome {
    const { result } = resolveCraps(raw, params.bet)
    if (result === 'push') return { win: false, playerDelta: 0n, multiplierX100: HUNDREDTHS }
    if (result === 'lose') return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const playerDelta = (stake * PAYOUT_X100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100: PAYOUT_X100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }] as const,
      [this.gameId, stake, betCode(params.bet), raw],
    ) as Hex
  },
}
