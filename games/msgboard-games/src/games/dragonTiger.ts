import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { dragonTigerRank, shuffleDeck } from '../cards'

/**
 * Dragon Tiger — pure-RNG, the simplest card game: one card to Dragon, one to Tiger, higher rank wins
 * (ace low). Bets: dragon / tiger (1:1) or tie (11:1). On a tie, dragon/tiger bets lose HALF (the
 * standard rule that funds the tie price). Deck is shuffled from the committed seed; nothing is
 * dealer-chosen, so the whole deal is recomputable — provably fair. Edge is structural (tie odds +
 * half-loss), no extra 1% applied.
 */
export type DragonTigerBet = 'dragon' | 'tiger' | 'tie'

export interface DragonTigerParams {
  bet: DragonTigerBet
}

export type DragonTigerWinner = 'dragon' | 'tiger' | 'tie'

export interface DragonTigerDeal {
  dragon: number
  tiger: number
  winner: DragonTigerWinner
}

const PAYOUT_X100: Record<DragonTigerBet, bigint> = { dragon: 200n, tiger: 200n, tie: 1200n }
// On a tie, a dragon/tiger bet returns half the stake (a 0.50x "loss of half").
const TIE_HALF_RETURN_X100 = 50n

/** Deal Dragon (deck[0]) and Tiger (deck[1]) from the seed-shuffled deck; higher rank wins, ace low. */
export function dealDragonTiger(raw: bigint): DragonTigerDeal {
  const deck = shuffleDeck(raw)
  const dragon = deck[0]!
  const tiger = deck[1]!
  const dr = dragonTigerRank(dragon)
  const tr = dragonTigerRank(tiger)
  const winner: DragonTigerWinner = dr > tr ? 'dragon' : tr > dr ? 'tiger' : 'tie'
  return { dragon, tiger, winner }
}

const betCode = (bet: DragonTigerBet): number => (bet === 'dragon' ? 0 : bet === 'tiger' ? 1 : 2)

export const dragonTiger: Game<DragonTigerParams> = {
  gameId: 12,
  maxMultiplierX100(params): bigint {
    return PAYOUT_X100[params.bet]
  },
  settleRound(stake, params, raw): RoundOutcome {
    const { winner } = dealDragonTiger(raw)
    if (winner === 'tie' && params.bet !== 'tie') {
      // dragon/tiger bet on a tie: lose half (return 0.50x).
      const playerDelta = (stake * TIE_HALF_RETURN_X100) / HUNDREDTHS - stake
      return { win: false, playerDelta, multiplierX100: TIE_HALF_RETURN_X100 }
    }
    const won = winner === params.bet
    if (!won) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const multiplierX100 = PAYOUT_X100[params.bet]
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }] as const,
      [this.gameId, stake, betCode(params.bet), raw],
    ) as Hex
  },
}
