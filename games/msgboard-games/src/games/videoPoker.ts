import { type Hex } from 'viem'
import { HUNDREDTHS } from '../game'
import { shuffleDeck } from '../cards'
import { rankFiveCard, FiveCardCategory } from '../poker'
import { commitLayout } from '../ladder'

/**
 * VIDEO POKER (gameId 22) — Jacks-or-Better, single decision (which cards to hold). Deal 5 from the
 * seed-shuffled deck; the player picks a hold mask; discarded positions are replaced from the next
 * cards of the SAME deck; the final 5-card hand is paid by the 9/6 paytable. The undrawn deck stays
 * hidden (committed) until settlement — the player chooses holds without seeing the replacement cards.
 * Trust model is mines-style (deck committed via keccak(seed), revealed + verified at settlement).
 * Payouts are "for 1" (return = multiple × bet); house edge is the usual skill-dependent JoB edge.
 */
export const VIDEO_POKER_GAME_ID = 22 as const

export interface VideoPokerDraw {
  dealt: number[]
  final: number[]
  category: FiveCardCategory
}

/** 9/6 Jacks-or-Better paytable, "for 1" multiples (return ÷ bet). NOTHING/JoB-push handled in settle. */
const PAYTABLE: Record<FiveCardCategory, bigint> = {
  [FiveCardCategory.NOTHING]: 0n,
  [FiveCardCategory.JACKS_OR_BETTER]: 1n, // 1 for 1 = push
  [FiveCardCategory.TWO_PAIR]: 2n,
  [FiveCardCategory.THREE_OF_A_KIND]: 3n,
  [FiveCardCategory.STRAIGHT]: 4n,
  [FiveCardCategory.FLUSH]: 6n,
  [FiveCardCategory.FULL_HOUSE]: 9n,
  [FiveCardCategory.FOUR_OF_A_KIND]: 25n,
  [FiveCardCategory.STRAIGHT_FLUSH]: 50n,
  [FiveCardCategory.ROYAL_FLUSH]: 800n,
}

const HAND = 5

/** Apply a hold mask (bit i = keep dealt[i]); discards are replaced from deck[5], deck[6], … in order. */
export function drawVideoPoker(seed: bigint, holdMask: number): VideoPokerDraw {
  if (!Number.isInteger(holdMask) || holdMask < 0 || holdMask >= 1 << HAND) throw new Error('videoPoker: bad hold mask')
  const deck = shuffleDeck(seed)
  const dealt = deck.slice(0, HAND)
  const final: number[] = new Array(HAND)
  let next = HAND
  for (let i = 0; i < HAND; i++) {
    final[i] = (holdMask >> i) & 1 ? dealt[i]! : deck[next++]!
  }
  return { dealt, final, category: rankFiveCard(final) }
}

export interface VideoPokerOutcome {
  playerDelta: bigint
  win: boolean
  multiplierX100: bigint
  category: FiveCardCategory
}

/** Settle a Video Poker hand from the seed and the player's hold mask. */
export function settleVideoPoker(stake: bigint, seed: bigint, holdMask: number): VideoPokerOutcome {
  const { category } = drawVideoPoker(seed, holdMask)
  const multiple = PAYTABLE[category]
  const multiplierX100 = multiple * HUNDREDTHS
  const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake // (multiple-1)·stake; -stake when multiple 0
  return { playerDelta, win: multiple > 1n, multiplierX100, category }
}

/** Escrow ceiling: the royal flush at 800-for-1. */
export function videoPokerMaxMultiplierX100(): bigint {
  return PAYTABLE[FiveCardCategory.ROYAL_FLUSH] * HUNDREDTHS // 80000
}

export function commitVideoPoker(seed: bigint): Hex {
  return commitLayout(seed)
}

export interface VideoPokerClaim {
  commit: Hex
  holdMask: number
  stake: bigint
  claimedDelta: bigint
}

export function verifyVideoPoker(claim: VideoPokerClaim, seed: bigint): { ok: boolean; reason?: string } {
  if (commitLayout(seed) !== claim.commit) return { ok: false, reason: 'seed does not match commitment' }
  const honest = settleVideoPoker(claim.stake, seed, claim.holdMask)
  if (honest.playerDelta !== claim.claimedDelta) return { ok: false, reason: 'claimed delta does not match honest replay' }
  return { ok: true }
}
