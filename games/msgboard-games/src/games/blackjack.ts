import { type Hex } from 'viem'
import { HUNDREDTHS } from '../game'
import { rankOf, shuffleDeck } from '../cards'
import { commitLayout } from '../ladder'

/**
 * BLACKJACK (gameId 23) — the multi-decision dealer game. Deck shuffled from the sealed seed; cards are
 * dealt in order (player, dealer-up, player, dealer-HOLE). The player HITs / STANDs / DOUBLEs; the
 * dealer then reveals the hole and draws to 17 (stands on all 17). The hole card and the undrawn deck
 * stay hidden (committed via keccak(seed)) until settlement — the player decides without seeing them —
 * exactly the mines trust model. NOT mental poker. Splits are out of scope (documented).
 *
 * Settlement replays the player's co-signed action sequence against the deck. Stakes: bet = `stake`;
 * DOUBLE doubles it for one final card. Blackjack (natural 21) pays 3:2; otherwise even money.
 */
export const BLACKJACK_GAME_ID = 23 as const

export type BlackjackAction = 'hit' | 'stand' | 'double'

/** Best blackjack total: aces count 11 then drop to 1 as needed. `soft` = an ace still counts 11. */
export function handTotal(cards: number[]): { total: number; soft: boolean } {
  let total = 0
  let aces = 0
  for (const c of cards) {
    const r = rankOf(c)
    if (r === 14) { aces++; total += 11 } else if (r >= 10) { total += 10 } else { total += r }
  }
  while (total > 21 && aces > 0) { total -= 10; aces-- }
  return { total, soft: aces > 0 }
}

export function isBlackjack(cards: number[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21
}

export interface BlackjackResult {
  playerCards: number[]
  dealerCards: number[]
  playerTotal: number
  dealerTotal: number
  doubled: boolean
  /** signed player delta in `stake` units. */
  playerDelta: bigint
  win: boolean
  multiplierX100: bigint
}

const err = (e: string): never => { throw new Error(`blackjack: ${e}`) }

/**
 * Settle a full hand from the seed and the player's action sequence. Deals player=[d0,d2],
 * dealer=[d1,d3(hole)], then applies actions drawing from d4… ; dealer draws to 17. Validates the
 * sequence (no action after a stand / bust / 21, DOUBLE only as the first action).
 */
export function settleBlackjack(stake: bigint, seed: bigint, actions: BlackjackAction[]): BlackjackResult {
  const deck = shuffleDeck(seed)
  const player = [deck[0]!, deck[2]!]
  const dealer = [deck[1]!, deck[3]!]
  let ptr = 4
  let doubled = false

  const playerBJ = isBlackjack(player)
  const dealerBJ = isBlackjack(dealer)

  if (playerBJ || dealerBJ) {
    if (actions.length !== 0) err('no actions allowed when a natural blackjack is dealt')
    return settleFinal(stake, player, dealer, false, true)
  }

  // player turn
  let standing = false
  for (let i = 0; i < actions.length; i++) {
    if (standing) err('action after the player turn ended')
    const a = actions[i]!
    if (a === 'stand') { standing = true; continue }
    if (a === 'double') {
      if (i !== 0) err('double is only allowed as the first action')
      doubled = true
      player.push(deck[ptr++]!)
      standing = true
      continue
    }
    // hit
    player.push(deck[ptr++]!)
    if (handTotal(player).total >= 21) standing = true // bust or 21 ends the turn
  }
  if (!standing) err('player turn did not end (missing stand)')

  // dealer turn (only if the player did not bust)
  if (handTotal(player).total <= 21) {
    while (handTotal(dealer).total < 17) dealer.push(deck[ptr++]!)
  }
  return settleFinal(stake, player, dealer, doubled, false)
}

function settleFinal(stake: bigint, player: number[], dealer: number[], doubled: boolean, naturals: boolean): BlackjackResult {
  const playerTotal = handTotal(player).total
  const dealerTotal = handTotal(dealer).total
  const bet = doubled ? stake * 2n : stake
  const playerBJ = isBlackjack(player)
  const dealerBJ = isBlackjack(dealer)

  let delta: bigint
  if (naturals) {
    if (playerBJ && dealerBJ) delta = 0n // push
    else if (playerBJ) delta = (stake * 3n) / 2n // blackjack pays 3:2
    else delta = -stake // dealer blackjack
  } else if (playerTotal > 21) {
    delta = -bet // player bust
  } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
    delta = bet // win even money
  } else if (playerTotal < dealerTotal) {
    delta = -bet
  } else {
    delta = 0n // push
  }

  const win = delta > 0n
  const multiplierX100 = delta >= 0n ? ((stake + delta) * HUNDREDTHS) / stake : 0n
  return { playerCards: player, dealerCards: dealer, playerTotal, dealerTotal, doubled, playerDelta: delta, win, multiplierX100 }
}

/** The player's mid-turn view after a prefix of actions: their cards + the dealer's UP card only.
 *  The hole card and undrawn deck are NOT exposed — the player acts without seeing them. */
export function blackjackPlayerView(seed: bigint, actions: BlackjackAction[]): {
  playerCards: number[]; dealerUp: number; playerTotal: number; busted: boolean; finished: boolean
} {
  const deck = shuffleDeck(seed)
  const player = [deck[0]!, deck[2]!]
  const dealerUp = deck[1]!
  let ptr = 4
  let finished = isBlackjack(player) || isBlackjack([deck[1]!, deck[3]!])
  for (const a of actions) {
    if (a === 'stand') { finished = true; break }
    if (a === 'double') { player.push(deck[ptr++]!); finished = true; break }
    player.push(deck[ptr++]!)
    if (handTotal(player).total >= 21) { finished = true; break }
  }
  const total = handTotal(player).total
  return { playerCards: player, dealerUp, playerTotal: total, busted: total > 21, finished }
}

/** Escrow ceiling: max profit is a double-down win (+2·stake) → 3.00x gross on the ante. */
export function blackjackMaxMultiplierX100(): bigint {
  return 300n
}

export function commitBlackjack(seed: bigint): Hex {
  return commitLayout(seed)
}

export interface BlackjackClaim {
  commit: Hex
  actions: BlackjackAction[]
  stake: bigint
  claimedDelta: bigint
}

export function verifyBlackjack(claim: BlackjackClaim, seed: bigint): { ok: boolean; reason?: string } {
  if (commitLayout(seed) !== claim.commit) return { ok: false, reason: 'seed does not match commitment' }
  try {
    const honest = settleBlackjack(claim.stake, seed, claim.actions)
    if (honest.playerDelta !== claim.claimedDelta) return { ok: false, reason: 'claimed delta does not match honest replay' }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  return { ok: true }
}
