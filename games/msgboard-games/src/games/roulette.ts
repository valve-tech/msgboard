import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'

/**
 * ROULETTE (gameId 25) — European single-zero wheel (37 pockets: 0..36). Decisionless: once the bets
 * are placed the winning pocket is a pure function of the sealed round seed (`raw % 37`), so it rides
 * the single-draw rails (no co-sign needed) exactly like the wheel/dice/keno formula games. The house
 * edge is STRUCTURAL — it comes entirely from the single green zero (2.70% on every even-money/outside
 * bet), NOT from the shared 1% edge helper — so the payouts here are the true European multiples and no
 * `applyEdge` is used.
 *
 * MULTI-BET per round: a player places a LIST of bets, each with its own stake, all resolved against the
 * one spun pocket; the round payout is the sum of the winning bets. The escrow ceiling is computed
 * exactly over all 37 pockets (the pocket that maximizes the total payout), so the house always covers
 * the worst case.
 *
 * Bet types & true European payouts (payout multiple on that bet's stake, stake INCLUSIVE):
 *   STRAIGHT   single number 0..36         35:1  -> 36×
 *   RED / BLACK                             1:1  ->  2×   (0 loses)
 *   ODD / EVEN                              1:1  ->  2×   (0 loses)
 *   HIGH (19-36) / LOW (1-18)               1:1  ->  2×   (0 loses)
 *   DOZEN  (1-12 / 13-24 / 25-36)           2:1  ->  3×   (0 loses)
 *   COLUMN (1st / 2nd / 3rd)                2:1  ->  3×   (0 loses)
 */
export const ROULETTE_GAME_ID = 25 as const

export const POCKETS = 37 // 0..36 (single zero)

export enum RouletteBetType {
  STRAIGHT = 0, // selection = the number 0..36
  RED = 1,
  BLACK = 2,
  ODD = 3,
  EVEN = 4,
  HIGH = 5, // 19..36
  LOW = 6, // 1..18
  DOZEN = 7, // selection = 0 (1-12), 1 (13-24), 2 (25-36)
  COLUMN = 8, // selection = 0 (1,4,..), 1 (2,5,..), 2 (3,6,..)
}

export interface RouletteBet {
  type: RouletteBetType
  /** for STRAIGHT: the number 0..36; for DOZEN/COLUMN: 0..2; ignored (must be 0) for the rest. */
  selection: number
  /** this bet's wager, in chip base units. */
  stake: bigint
}

export interface RouletteParams {
  bets: RouletteBet[]
}

/** Red pockets on a European wheel, as a bitmask (bit `n` set ⇒ `n` is red). 0 and blacks are unset. */
export const RED_MASK = 91447186090n // {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36}

export function isRed(pocket: number): boolean {
  if (pocket < 1 || pocket > 36) return false
  return ((RED_MASK >> BigInt(pocket)) & 1n) === 1n
}

const MAX_BETS = 64

/** Validate a single bet's type/selection and non-zero stake. Throws on any malformed bet. */
export function validateBet(bet: RouletteBet): void {
  if (!Number.isInteger(bet.type) || bet.type < 0 || bet.type > 8) throw new Error('roulette: bad bet type')
  if (bet.stake <= 0n) throw new Error('roulette: bet stake must be positive')
  if (bet.type === RouletteBetType.STRAIGHT) {
    if (!Number.isInteger(bet.selection) || bet.selection < 0 || bet.selection >= POCKETS) {
      throw new Error('roulette: straight selection out of range [0,36]')
    }
  } else if (bet.type === RouletteBetType.DOZEN || bet.type === RouletteBetType.COLUMN) {
    if (!Number.isInteger(bet.selection) || bet.selection < 0 || bet.selection > 2) {
      throw new Error('roulette: dozen/column selection out of range [0,2]')
    }
  } else if (bet.selection !== 0) {
    throw new Error('roulette: selection must be 0 for this bet type')
  }
}

export function validateRouletteParams(params: RouletteParams): void {
  if (!Array.isArray(params.bets) || params.bets.length < 1 || params.bets.length > MAX_BETS) {
    throw new Error(`roulette: bets count out of range [1,${MAX_BETS}]`)
  }
  for (const bet of params.bets) validateBet(bet)
}

/** The winning pocket for a round random: `raw % 37`. */
export function rouletteWinningPocket(raw: bigint): number {
  return Number(raw % BigInt(POCKETS))
}

/** Payout MULTIPLE (×100, stake-inclusive) a bet type pays when it wins: 3600 / 300 / 200. */
export function rouletteBetPayoutX100(type: RouletteBetType): bigint {
  switch (type) {
    case RouletteBetType.STRAIGHT:
      return 3600n // 35:1
    case RouletteBetType.DOZEN:
    case RouletteBetType.COLUMN:
      return 300n // 2:1
    default:
      return 200n // 1:1 (red/black/odd/even/high/low)
  }
}

/** Does `bet` win against the spun `pocket`? Pure, decision-free. */
export function betWins(bet: RouletteBet, pocket: number): boolean {
  switch (bet.type) {
    case RouletteBetType.STRAIGHT:
      return pocket === bet.selection
    case RouletteBetType.RED:
      return isRed(pocket)
    case RouletteBetType.BLACK:
      return pocket >= 1 && pocket <= 36 && !isRed(pocket)
    case RouletteBetType.ODD:
      return pocket >= 1 && pocket <= 36 && pocket % 2 === 1
    case RouletteBetType.EVEN:
      return pocket >= 1 && pocket <= 36 && pocket % 2 === 0
    case RouletteBetType.HIGH:
      return pocket >= 19 && pocket <= 36
    case RouletteBetType.LOW:
      return pocket >= 1 && pocket <= 18
    case RouletteBetType.DOZEN:
      return pocket >= 1 && pocket <= 36 && Math.floor((pocket - 1) / 12) === bet.selection
    case RouletteBetType.COLUMN:
      return pocket >= 1 && pocket <= 36 && (pocket - 1) % 3 === bet.selection
    default:
      return false
  }
}

/** Total payout (stake-inclusive) across all bets for a spun `pocket`. */
export function roulettePayout(params: RouletteParams, pocket: number): bigint {
  let payout = 0n
  for (const bet of params.bets) {
    if (betWins(bet, pocket)) payout += (bet.stake * rouletteBetPayoutX100(bet.type)) / HUNDREDTHS
  }
  return payout
}

/** Sum of all bet stakes — the total wager the player commits for the round. */
export function rouletteTotalStake(params: RouletteParams): bigint {
  let total = 0n
  for (const bet of params.bets) total += bet.stake
  return total
}

export const roulette: Game<RouletteParams> = {
  gameId: ROULETTE_GAME_ID,
  maxMultiplierX100(params): bigint {
    validateRouletteParams(params)
    const total = rouletteTotalStake(params)
    // The pot must cover the pocket that maximizes the total payout. Return the smallest multiple M
    // (×100 of the TOTAL stake) with total*M/100 >= maxPayout, i.e. M = ceil(100*maxPayout/total).
    let maxPayout = 0n
    for (let p = 0; p < POCKETS; p++) {
      const payout = roulettePayout(params, p)
      if (payout > maxPayout) maxPayout = payout
    }
    return (maxPayout * HUNDREDTHS + total - 1n) / total // ceil
  },
  settleRound(stake, params, raw): RoundOutcome {
    validateRouletteParams(params)
    const total = rouletteTotalStake(params)
    if (total !== stake) throw new Error('roulette: stake must equal the sum of bet stakes')
    const pocket = rouletteWinningPocket(raw)
    const payout = roulettePayout(params, pocket)
    const playerDelta = payout - stake
    const win = payout > stake
    const multiplierX100 = (payout * HUNDREDTHS) / stake
    return { win, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [
        { type: 'uint8' },
        { type: 'uint256' },
        {
          type: 'tuple[]',
          components: [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }],
        },
        { type: 'uint256' },
      ] as const,
      [
        this.gameId,
        stake,
        params.bets.map((b) => [b.type, b.selection, b.stake]) as any,
        raw,
      ],
    ) as Hex
  },
}

/** ABI encoding of just the bets array — the `params` blob the on-chain GamePayouts mirror decodes. */
export function encodeRouletteParams(params: RouletteParams): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }],
      },
    ] as const,
    [params.bets.map((b) => [b.type, b.selection, b.stake]) as any],
  ) as Hex
}
