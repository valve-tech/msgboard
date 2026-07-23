import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'

/**
 * Monte — three-card monte. Three face-down positions; one hides the winning card. The player picks a
 * position at OPEN; the winning position is seed-derived (`raw % 3`), so the house cannot move the
 * card after seeing the pick. A correct guess pays ~3x, edged. Pure single-draw (P1), recompute-settle.
 */
export interface MonteParams {
  /** the chosen position, 0..2. */
  pick: number
}

export const SLOTS = 3 // three cards
const BPS = 10_000n

/** the winning position in [0, SLOTS-1], from the round random. */
export function monteWinningSlot(raw: bigint): number {
  return Number(raw % BigInt(SLOTS))
}

/** payout multiplier (hundredths) for a correct guess: SLOTS * (1-edge), edged once. */
export function monteMultiplierX100(): bigint {
  // fair = SLOTS/1 == SLOTS.00x; edged = fair * (1-edge).
  return (BigInt(SLOTS) * HUNDREDTHS * (BPS - EDGE_BPS)) / BPS // 3*100*9900/10000 = 297
}

function validatePick(pick: number): void {
  if (!Number.isInteger(pick) || pick < 0 || pick >= SLOTS) throw new Error('monte: pick out of range [0,2]')
}

export const monte: Game<MonteParams> = {
  gameId: 9,
  maxMultiplierX100(params): bigint {
    // No payout variance — a win always pays exactly this, so it is also the escrow ceiling.
    validatePick(params.pick)
    return monteMultiplierX100()
  },
  settleRound(stake, params, raw): RoundOutcome {
    validatePick(params.pick)
    const winning = monteWinningSlot(raw)
    const win = params.pick === winning
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const multiplierX100 = monteMultiplierX100()
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.pick, raw],
    ) as Hex
  },
}
