import { type Hex } from 'viem'
import { HUNDREDTHS } from '../game'
import { rankOf, shuffleDeck } from '../cards'
import { rankThreeCard, ThreeCardCategory } from '../poker'
import { commitLayout } from '../ladder'

/**
 * THREE CARD POKER (gameId 21) — single-player vs dealer, ONE decision (play or fold). The deck is
 * shuffled from the sealed seed; the player sees their 3 cards and decides; the dealer's 3 cards stay
 * hidden (committed, revealed only after the decision) and the dealer qualifies on Queen-high or
 * better. NOT mental poker — cards are public once dealt and no other PLAYER holds hidden info; the
 * trust model is mines-style (commit the deck via keccak(seed); reveal player cards, take the co-signed
 * decision, then reveal the rest; verify the whole deal against the revealed seed at settlement).
 *
 * Stakes: an ante of `stake`; choosing PLAY adds an equal play bet (2× at risk). Payouts (ante units):
 *   fold → −1; play & dealer doesn't qualify → +1 (play pushes); play & win → +2; play & lose → −2;
 *   tie → 0. Plus an ANTE BONUS on the player's hand (paid on PLAY regardless of the dealer): straight
 *   +1, trips +4, straight flush +5. Edge is structural (dealer-qualify rule + fixed paytable).
 */
export const THREE_CARD_GAME_ID = 21 as const

export type ThreeCardDecision = 'play' | 'fold'

export interface ThreeCardDeal {
  player: number[]
  dealer: number[]
  dealerQualifies: boolean
}

export interface ThreeCardOutcome {
  /** signed player delta in ante (stake) units. */
  playerDelta: bigint
  win: boolean
  /** gross-return multiplier on the ante, hundredths (for display); 0 on a net loss. */
  multiplierX100: bigint
}

const QUEEN = 12

/** ante-bonus multiple on the player's hand (paid on PLAY regardless of the dealer). */
function anteBonusUnits(category: ThreeCardCategory): bigint {
  if (category === ThreeCardCategory.STRAIGHT_FLUSH) return 5n
  if (category === ThreeCardCategory.TRIPS) return 4n
  if (category === ThreeCardCategory.STRAIGHT) return 1n
  return 0n
}

/** Deal player (deck[0..2]) and dealer (deck[3..5]) from the seed-shuffled deck. */
export function dealThreeCard(seed: bigint): ThreeCardDeal {
  const deck = shuffleDeck(seed)
  const player = [deck[0]!, deck[1]!, deck[2]!]
  const dealer = [deck[3]!, deck[4]!, deck[5]!]
  const dr = rankThreeCard(dealer)
  const dealerHigh = Math.max(...dealer.map(rankOf))
  const dealerQualifies = dr.category > ThreeCardCategory.HIGH_CARD || dealerHigh >= QUEEN
  return { player, dealer, dealerQualifies }
}

/** Settle a Three Card Poker hand from the seed and the player's decision. */
export function settleThreeCard(stake: bigint, seed: bigint, decision: ThreeCardDecision): ThreeCardOutcome {
  const { player, dealer, dealerQualifies } = dealThreeCard(seed)
  if (decision === 'fold') return { playerDelta: -stake, win: false, multiplierX100: 0n }

  const p = rankThreeCard(player)
  const d = rankThreeCard(dealer)
  const bonus = anteBonusUnits(p.category) * stake // paid regardless of the dealer

  let baseUnits: bigint // in ante units
  if (!dealerQualifies) baseUnits = 1n // ante wins 1:1, play pushes
  else if (p.score > d.score) baseUnits = 2n // ante + play both win
  else if (p.score < d.score) baseUnits = -2n // lose ante + play
  else baseUnits = 0n // tie pushes both

  const playerDelta = baseUnits * stake + bonus
  const win = playerDelta > 0n
  const multiplierX100 = playerDelta >= 0n ? ((stake + playerDelta) * HUNDREDTHS) / stake : 0n
  return { playerDelta, win, multiplierX100 }
}

/** Escrow ceiling on the ante: max gross return = straight-flush win (+2) + ante bonus (+5) = 8.00x. */
export function threeCardMaxMultiplierX100(): bigint {
  return 800n
}

/** Commit to the deck (binds it before any reveal). */
export function commitThreeCard(seed: bigint): Hex {
  return commitLayout(seed)
}

export interface ThreeCardClaim {
  commit: Hex
  decision: ThreeCardDecision
  stake: bigint
  claimedDelta: bigint
}

/** Adjudicate a finished hand: the seed must match the commitment and reproduce the claimed delta. */
export function verifyThreeCard(claim: ThreeCardClaim, seed: bigint): { ok: boolean; reason?: string } {
  if (commitLayout(seed) !== claim.commit) return { ok: false, reason: 'seed does not match commitment' }
  const honest = settleThreeCard(claim.stake, seed, claim.decision)
  if (honest.playerDelta !== claim.claimedDelta) return { ok: false, reason: 'claimed delta does not match honest replay' }
  return { ok: true }
}
