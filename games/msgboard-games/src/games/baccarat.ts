import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { baccaratValue, shuffleDeck } from '../cards'

/**
 * Baccarat (punto banco) — pure-RNG, no player decisions, so it rides the single-draw rails. The deck
 * is shuffled from the committed seed; both hands are dealt and resolved by the FIXED third-card rules
 * (the player has no choices), then paid by the chosen bet. The house edge here is STRUCTURAL — the
 * banker commission (0.95:1) and the tie price (8:1) — NOT an extra 1% on top, so EDGE_BPS is not
 * applied. Provably fair: the entire deal is recomputable from the seed; nothing is dealer-chosen.
 */
export type BaccaratBet = 'player' | 'banker' | 'tie'

export interface BaccaratParams {
  bet: BaccaratBet
}

export type BaccaratWinner = 'player' | 'banker' | 'tie'

export interface BaccaratDeal {
  playerCards: number[]
  bankerCards: number[]
  playerTotal: number
  bankerTotal: number
  winner: BaccaratWinner
}

// payout multipliers in hundredths (stake returned + winnings): player 1:1, banker 0.95:1, tie 8:1.
const PAYOUT_X100: Record<BaccaratBet, bigint> = { player: 200n, banker: 195n, tie: 900n }

const total = (cards: number[]): number => cards.reduce((s, c) => s + baccaratValue(c), 0) % 10

/** Should the banker draw a third card given the banker total and the player's third-card pip value? */
function bankerDrawsAfterPlayerThird(bankerTotal: number, playerThirdPip: number): boolean {
  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true
    case 3:
      return playerThirdPip !== 8
    case 4:
      return playerThirdPip >= 2 && playerThirdPip <= 7
    case 5:
      return playerThirdPip >= 4 && playerThirdPip <= 7
    case 6:
      return playerThirdPip >= 6 && playerThirdPip <= 7
    default:
      return false // 7 stands (8/9 are naturals, handled earlier)
  }
}

/** Deal a full baccarat coup from the seed-shuffled deck per the fixed third-card rules. */
export function dealBaccarat(raw: bigint): BaccaratDeal {
  const deck = shuffleDeck(raw)
  let ptr = 4
  const playerCards = [deck[0]!, deck[2]!]
  const bankerCards = [deck[1]!, deck[3]!]
  let playerTotal = total(playerCards)
  let bankerTotal = total(bankerCards)

  const natural = playerTotal >= 8 || bankerTotal >= 8
  if (!natural) {
    let playerThirdPip: number | null = null
    if (playerTotal <= 5) {
      const card = deck[ptr++]!
      playerCards.push(card)
      playerThirdPip = baccaratValue(card)
      playerTotal = total(playerCards)
    }
    const bankerDraws =
      playerThirdPip === null ? bankerTotal <= 5 : bankerDrawsAfterPlayerThird(bankerTotal, playerThirdPip)
    if (bankerDraws) {
      bankerCards.push(deck[ptr++]!)
      bankerTotal = total(bankerCards)
    }
  }

  const winner: BaccaratWinner =
    playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie'
  return { playerCards, bankerCards, playerTotal, bankerTotal, winner }
}

const betCode = (bet: BaccaratBet): number => (bet === 'player' ? 0 : bet === 'banker' ? 1 : 2)

export const baccarat: Game<BaccaratParams> = {
  gameId: 11,
  maxMultiplierX100(params): bigint {
    // Fixed payout per bet — the escrow ceiling is that bet's payout multiplier (tie is the largest).
    return PAYOUT_X100[params.bet]
  },
  settleRound(stake, params, raw): RoundOutcome {
    const { winner } = dealBaccarat(raw)
    // A player/banker bet PUSHES on a tie (stake returned); a tie bet LOSES on a non-tie.
    if (winner === 'tie' && params.bet !== 'tie') {
      return { win: false, playerDelta: 0n, multiplierX100: HUNDREDTHS } // push
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
