import { type Hex } from 'viem'
import { HUNDREDTHS } from '../game'
import { rankOf, suitOf, shuffleDeck } from '../cards'
import { commitLayout } from '../ladder'

/**
 * PAI GOW POKER (gameId 27) — single player vs the house. From a seed-shuffled deck each side gets 7
 * cards; each is split into a 5-card "back" (high) hand and a 2-card "front" (low) hand, with the rule
 * that the back MUST rank at least as high as the front (an illegal "foul" arrangement loses). The
 * dealer always sets by a fixed HOUSE WAY; the player sets their own split (the decision). Each hand is
 * compared; the DEALER WINS COPIES (ties). The player wins the bet only by winning BOTH hands, loses by
 * winning NEITHER, and pushes when each side wins one. NOT mental poker — the deck is committed via
 * keccak(seed) and revealed at settlement, exactly the mines/blackjack trust model (the player sets
 * their hand seeing only their own 7 cards; the dealer's 7 stay hidden until reveal).
 *
 * VARIANT (documented): commission-free, even-money wins (no 5% rake). We use a standard 52-card deck
 * with NO JOKER, so the whole deal reuses the existing on-chain-reproducible shuffleDeck — a documented
 * simplification of casino Pai Gow (which adds one semi-wild joker). The house edge is STRUCTURAL: it
 * comes from the copy rule (dealer wins ties on each hand) plus the frequency of push outcomes, not from
 * any commission. HOUSE WAY (documented, deterministic): among all legal splits, choose the one that
 * MAXIMIZES the 5-card back hand, breaking ties by the strongest 2-card front — a legal split always
 * exists (the best 5-card hand as the back is never fouled by its 2 leftovers).
 */
export const PAI_GOW_GAME_ID = 27 as const

// ---------------------------------------------------------------------------
// hand evaluation — self-contained, ace-high (rank 2..14), base-15 comparable scores
// ---------------------------------------------------------------------------

export enum PaiGowCategory {
  HIGH_CARD = 0,
  PAIR = 1,
  TWO_PAIR = 2,
  TRIPS = 3,
  STRAIGHT = 4,
  FLUSH = 5,
  FULL_HOUSE = 6,
  QUADS = 7,
  STRAIGHT_FLUSH = 8, // a royal flush folds in here (it is the ace-high straight flush)
}

const B15 = 15n // base-15 digit weight (ranks 2..14 fit in one digit)

function ranksDesc(cards: number[]): number[] {
  return cards.map(rankOf).sort((a, b) => b - a)
}

function isFlush5(cards: number[]): boolean {
  const s = suitOf(cards[0]!)
  return cards.every((c) => suitOf(c) === s)
}

/** rank->count map for the hand. */
function counts(cards: number[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const c of cards) m.set(rankOf(c), (m.get(rankOf(c)) ?? 0) + 1)
  return m
}

/** Straight high card over 5 DISTINCT ranks (ace-low wheel A-2-3-4-5 → high 5), or null. */
function straightHigh5(distinctDesc: number[]): number | null {
  if (distinctDesc.length !== 5) return null
  const s = [...distinctDesc].sort((a, b) => a - b) // ascending
  let run = true
  for (let i = 1; i < 5; i++) if (s[i] !== s[i - 1]! + 1) run = false
  if (run) return s[4]!
  // wheel: A,2,3,4,5 (ace 14 acting as 1) → high card 5
  if (s[0] === 2 && s[1] === 3 && s[2] === 4 && s[3] === 5 && s[4] === 14) return 5
  return null
}

/** Pack a category + up to 5 significant ranks into one comparable bigint (base-15). */
function packScore(category: PaiGowCategory, ordered: number[]): bigint {
  let score = BigInt(category)
  for (let i = 0; i < 5; i++) score = score * B15 + BigInt(ordered[i] ?? 0)
  return score
}

/** Evaluate a 5-card back hand into a comparable score (higher = stronger). */
export function rankFivePaiGow(cards: number[]): { category: PaiGowCategory; score: bigint } {
  if (cards.length !== 5) throw new Error('rankFivePaiGow: need 5 cards')
  const cnt = counts(cards)
  const countVals = [...cnt.values()].sort((a, b) => b - a)
  const flush = isFlush5(cards)
  const distinct = [...cnt.keys()].sort((a, b) => b - a)
  const sHigh = distinct.length === 5 ? straightHigh5(distinct) : null
  const rd = ranksDesc(cards)

  let category: PaiGowCategory
  let ordered: number[]
  if (flush && sHigh !== null) {
    category = PaiGowCategory.STRAIGHT_FLUSH
    ordered = [sHigh]
  } else if (countVals[0] === 4) {
    category = PaiGowCategory.QUADS
    const quad = [...cnt.entries()].find(([, n]) => n === 4)![0]
    const kicker = [...cnt.entries()].find(([, n]) => n === 1)![0]
    ordered = [quad, kicker]
  } else if (countVals[0] === 3 && countVals[1] === 2) {
    category = PaiGowCategory.FULL_HOUSE
    const trip = [...cnt.entries()].find(([, n]) => n === 3)![0]
    const pair = [...cnt.entries()].find(([, n]) => n === 2)![0]
    ordered = [trip, pair]
  } else if (flush) {
    category = PaiGowCategory.FLUSH
    ordered = rd
  } else if (sHigh !== null) {
    category = PaiGowCategory.STRAIGHT
    ordered = [sHigh]
  } else if (countVals[0] === 3) {
    category = PaiGowCategory.TRIPS
    const trip = [...cnt.entries()].find(([, n]) => n === 3)![0]
    const kickers = [...cnt.entries()].filter(([, n]) => n === 1).map(([r]) => r).sort((a, b) => b - a)
    ordered = [trip, kickers[0]!, kickers[1]!]
  } else if (countVals[0] === 2 && countVals[1] === 2) {
    category = PaiGowCategory.TWO_PAIR
    const pairs = [...cnt.entries()].filter(([, n]) => n === 2).map(([r]) => r).sort((a, b) => b - a)
    const kicker = [...cnt.entries()].find(([, n]) => n === 1)![0]
    ordered = [pairs[0]!, pairs[1]!, kicker]
  } else if (countVals[0] === 2) {
    category = PaiGowCategory.PAIR
    const pair = [...cnt.entries()].find(([, n]) => n === 2)![0]
    const kickers = [...cnt.entries()].filter(([, n]) => n === 1).map(([r]) => r).sort((a, b) => b - a)
    ordered = [pair, kickers[0]!, kickers[1]!, kickers[2]!]
  } else {
    category = PaiGowCategory.HIGH_CARD
    ordered = rd
  }
  return { category, score: packScore(category, ordered) }
}

/** Evaluate a 2-card front hand: only HIGH_CARD (cat 0) or PAIR (cat 1). */
export function rankTwoPaiGow(cards: number[]): { category: PaiGowCategory; score: bigint } {
  if (cards.length !== 2) throw new Error('rankTwoPaiGow: need 2 cards')
  const a = rankOf(cards[0]!)
  const b = rankOf(cards[1]!)
  if (a === b) return { category: PaiGowCategory.PAIR, score: packScore(PaiGowCategory.PAIR, [a, a]) }
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return { category: PaiGowCategory.HIGH_CARD, score: packScore(PaiGowCategory.HIGH_CARD, [hi, lo]) }
}

// ---------------------------------------------------------------------------
// split legality (foul) + house way
// ---------------------------------------------------------------------------

/**
 * Is the split (front 2 cards, back 5 cards) a FOUL — i.e. does the front outrank the back? A foul loses.
 * The back can hold any 5-card category; the front is at most a pair, so:
 *   - back is two-pair or better (cat >= 2): never a foul;
 *   - back is a pair: foul iff the front is a pair of equal-or-higher rank;
 *   - back is high card: a front PAIR always fouls; two front singletons foul iff they beat the back's
 *     two highest cards (compare top card, then second).
 */
export function isFoul(front: number[], back: number[]): boolean {
  const f = rankTwoPaiGow(front)
  const b = rankFivePaiGow(back)
  if (b.category >= PaiGowCategory.TWO_PAIR) return false
  if (b.category === PaiGowCategory.PAIR) {
    if (f.category === PaiGowCategory.HIGH_CARD) return false
    const backPair = [...counts(back).entries()].find(([, n]) => n === 2)![0]
    const frontPair = rankOf(front[0]!) // front is a pair here
    return frontPair >= backPair
  }
  // back is a high card (cat 0)
  if (f.category === PaiGowCategory.PAIR) return true
  const fd = ranksDesc(front)
  const bd = ranksDesc(back)
  if (fd[0]! > bd[0]!) return true
  if (fd[0]! === bd[0]! && fd[1]! > bd[1]!) return true
  return false
}

export interface PaiGowSplit {
  /** the 2-card front hand (card indices). */
  front: number[]
  /** the 5-card back hand (card indices). */
  back: number[]
  frontScore: bigint
  backScore: bigint
}

/** All 21 ways to choose 2 of 7 positions for the front; returns [frontPositions, backPositions]. */
function frontChoices(): [number[], number[]][] {
  const out: [number[], number[]][] = []
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      const front = [i, j]
      const back = [0, 1, 2, 3, 4, 5, 6].filter((p) => p !== i && p !== j)
      out.push([front, back])
    }
  }
  return out
}

/**
 * The HOUSE WAY split of 7 cards: among all LEGAL (non-foul) splits, the one with the strongest back
 * hand, breaking ties by the strongest front. Deterministic; a legal split always exists.
 */
export function houseWaySplit(seven: number[]): PaiGowSplit {
  if (seven.length !== 7) throw new Error('houseWaySplit: need 7 cards')
  let best: PaiGowSplit | null = null
  for (const [fp, bp] of frontChoices()) {
    const front = fp.map((p) => seven[p]!)
    const back = bp.map((p) => seven[p]!)
    if (isFoul(front, back)) continue
    const backScore = rankFivePaiGow(back).score
    const frontScore = rankTwoPaiGow(front).score
    if (best === null || backScore > best.backScore || (backScore === best.backScore && frontScore > best.frontScore)) {
      best = { front, back, frontScore, backScore }
    }
  }
  if (best === null) throw new Error('houseWaySplit: no legal split (unreachable)')
  return best
}

// ---------------------------------------------------------------------------
// deal + settlement
// ---------------------------------------------------------------------------

export type PaiGowResult = 'lose' | 'push' | 'win'

export interface PaiGowOutcome {
  playerFront: number[]
  playerBack: number[]
  dealerFront: number[]
  dealerBack: number[]
  fouled: boolean
  result: PaiGowResult
  /** signed player delta in stake units. */
  playerDelta: bigint
  win: boolean
  /** gross-return multiplier on the stake, hundredths: win 200, push 100, loss 0. */
  multiplierX100: bigint
}

/** Deal the two 7-card hands from the seed-shuffled deck: player = deck[0..6], dealer = deck[7..13]. */
export function dealPaiGow(seed: bigint): { player: number[]; dealer: number[] } {
  const deck = shuffleDeck(seed)
  return { player: deck.slice(0, 7), dealer: deck.slice(7, 14) }
}

/** Normalize + validate the player's chosen front positions (2 distinct indices in 0..6). */
export function normalizeFrontPositions(positions: number[]): [number, number] {
  if (positions.length !== 2) throw new Error('paiGow: front must be exactly 2 positions')
  const [a, b] = positions
  if (!Number.isInteger(a) || !Number.isInteger(b) || a! < 0 || a! > 6 || b! < 0 || b! > 6 || a === b) {
    throw new Error('paiGow: front positions must be 2 distinct indices in [0,6]')
  }
  return a! < b! ? [a!, b!] : [b!, a!]
}

/** The player's own house-way front positions (for an "auto-set" convenience). */
export function playerHouseWayPositions(seed: bigint): [number, number] {
  const { player } = dealPaiGow(seed)
  const split = houseWaySplit(player)
  // recover the positions of the front cards within the player's 7
  const idx = split.front.map((c) => player.indexOf(c))
  return normalizeFrontPositions(idx)
}

/**
 * Settle a Pai Gow hand from the seed and the player's chosen front positions (the 2 cards they place in
 * the low hand; the other 5 form the back). The dealer sets by house way. Dealer wins copies; the player
 * wins the bet by winning BOTH hands, loses by winning neither, else pushes. A fouled player split loses.
 */
export function settlePaiGow(stake: bigint, seed: bigint, frontPositions: number[]): PaiGowOutcome {
  const { player, dealer } = dealPaiGow(seed)
  const [fa, fb] = normalizeFrontPositions(frontPositions)
  const playerFront = [player[fa]!, player[fb]!]
  const playerBack = [0, 1, 2, 3, 4, 5, 6].filter((p) => p !== fa && p !== fb).map((p) => player[p]!)

  const dealerSplit = houseWaySplit(dealer)
  const dealerFront = dealerSplit.front
  const dealerBack = dealerSplit.back

  const fouled = isFoul(playerFront, playerBack)
  let result: PaiGowResult
  if (fouled) {
    result = 'lose'
  } else {
    const pBack = rankFivePaiGow(playerBack).score
    const pFront = rankTwoPaiGow(playerFront).score
    const dBack = rankFivePaiGow(dealerBack).score
    const dFront = rankTwoPaiGow(dealerFront).score
    const winsBack = pBack > dBack // dealer wins copies (ties)
    const winsFront = pFront > dFront
    if (winsBack && winsFront) result = 'win'
    else if (!winsBack && !winsFront) result = 'lose'
    else result = 'push'
  }

  const playerDelta = result === 'win' ? stake : result === 'lose' ? -stake : 0n
  const multiplierX100 = result === 'win' ? 200n : result === 'push' ? HUNDREDTHS : 0n
  return {
    playerFront, playerBack, dealerFront, dealerBack, fouled, result,
    playerDelta, win: result === 'win', multiplierX100,
  }
}

/** Encode the result as the on-chain claim code (0 lose, 1 push, 2 win). */
export function paiGowResultCode(result: PaiGowResult): number {
  return result === 'lose' ? 0 : result === 'push' ? 1 : 2
}

/** Escrow ceiling: an even-money win returns 2.00x the stake. */
export function paiGowMaxMultiplierX100(): bigint {
  return 200n
}

/** Commit to the deck (binds it before any reveal). */
export function commitPaiGow(seed: bigint): Hex {
  return commitLayout(seed)
}

export interface PaiGowClaim {
  commit: Hex
  frontPositions: number[]
  stake: bigint
  claimedDelta: bigint
}

/** Adjudicate a finished hand: the seed must match the commitment and reproduce the claimed delta. */
export function verifyPaiGow(claim: PaiGowClaim, seed: bigint): { ok: boolean; reason?: string } {
  if (commitLayout(seed) !== claim.commit) return { ok: false, reason: 'seed does not match commitment' }
  try {
    const honest = settlePaiGow(claim.stake, seed, claim.frontPositions)
    if (honest.playerDelta !== claim.claimedDelta) return { ok: false, reason: 'claimed delta does not match honest replay' }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  return { ok: true }
}
