import { diceMultiplierX100 } from './games/dice'

/** Roll-under win multiplier (hundredths) for a given target, with the 1% house edge applied.
 *  Delegates to the canonical diceMultiplierX100 so escrow sizing exactly matches settlement. */
export function diceMaxMultiplierX100(params: { targetX100: bigint }): bigint {
  return diceMultiplierX100(params.targetX100)
}

/** Escrow amounts for a Dice round.
 *  - escrowPlayer: the player's stake (they lose this on a loss).
 *  - escrowHouse: what the house must lock to cover the player's max profit on a win.
 *    = stake * (multiplierX100 - 100) / 100
 *    e.g. 1.98x → house locks 0.98 × stake so combined pot = stake × 1.98 */
export function escrowFor(
  stake: bigint,
  multiplierX100: bigint,
): { escrowPlayer: bigint; escrowHouse: bigint } {
  return {
    escrowPlayer: stake,
    escrowHouse: (stake * (multiplierX100 - 100n)) / 100n,
  }
}
