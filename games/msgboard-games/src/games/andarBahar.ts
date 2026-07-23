import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { rankOf, shuffleDeck } from '../cards'

/**
 * Andar Bahar — pure-RNG. A "joker" card is revealed (deck[0]); cards are then dealt alternately to
 * Andar (first) and Bahar from the rest of the seed-shuffled deck until one matches the joker's RANK.
 * The matching side wins. Andar is dealt first (a slight edge) so it pays 0.9:1; Bahar pays 1:1 — that
 * asymmetry is the structural house edge (no extra 1%). The deal is fully seed-determined and
 * recomputable, so it is provably fair. A rank-match is guaranteed (3 more of the joker's rank remain).
 */
export type AndarBaharBet = 'andar' | 'bahar'

export interface AndarBaharParams {
  bet: AndarBaharBet
}

export interface AndarBaharDeal {
  joker: number
  winner: AndarBaharBet
  /** number of cards dealt (after the joker) before and including the match. */
  cardsDealt: number
}

// Andar dealt first → pays 0.9:1 (return 1.9x); Bahar pays 1:1 (return 2.0x).
const PAYOUT_X100: Record<AndarBaharBet, bigint> = { andar: 190n, bahar: 200n }

/** Reveal the joker (deck[0]) and deal alternately Andar, Bahar… until the joker rank is matched. */
export function dealAndarBahar(raw: bigint): AndarBaharDeal {
  const deck = shuffleDeck(raw)
  const joker = deck[0]!
  const jokerRank = rankOf(joker)
  let turn: AndarBaharBet = 'andar'
  for (let i = 1; i < deck.length; i++) {
    const card = deck[i]!
    if (rankOf(card) === jokerRank) {
      return { joker, winner: turn, cardsDealt: i }
    }
    turn = turn === 'andar' ? 'bahar' : 'andar'
  }
  // Unreachable: with one card removed, 3 of the joker's rank remain in the 51 dealt.
  throw new Error('andar-bahar: no rank match found (impossible for a full deck)')
}

const betCode = (bet: AndarBaharBet): number => (bet === 'andar' ? 0 : 1)

export const andarBahar: Game<AndarBaharParams> = {
  gameId: 13,
  maxMultiplierX100(params): bigint {
    return PAYOUT_X100[params.bet]
  },
  settleRound(stake, params, raw): RoundOutcome {
    const { winner } = dealAndarBahar(raw)
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
