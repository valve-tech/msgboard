import { rankOf, suitOf } from './cards'

/**
 * Poker hand evaluation for the single-player-vs-dealer card games (Three Card Poker, Video Poker).
 * Pure and deterministic over card indices (see cards.ts: rank 2..14 ace-high, suit = index % 4).
 * Returns comparable scores so the dealer's fixed rules and the paytables can be applied without any
 * external state — the whole hand resolution is recomputable from the committed deck (provably fair).
 */

// ---- shared helpers ----

/** rank-count map and the sorted (desc) distinct ranks of a hand. */
function rankCounts(cards: number[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const c of cards) m.set(rankOf(c), (m.get(rankOf(c)) ?? 0) + 1)
  return m
}

function isFlush(cards: number[]): boolean {
  const s = suitOf(cards[0]!)
  return cards.every((c) => suitOf(c) === s)
}

/** Is `ranks` (a set of DISTINCT ranks) a run of `len`? Handles the ace-low wheel (A-2-3-4-5). */
function straightHigh(ranks: number[], len: number): number | null {
  if (ranks.length !== len) return null
  const sorted = [...ranks].sort((a, b) => a - b)
  let consecutive = sorted.every((r, i) => i === 0 || r === sorted[i - 1]! + 1)
  if (consecutive) return sorted[sorted.length - 1]! // high card
  // wheel: A(14) acting as 1 below the lowest
  if (sorted[sorted.length - 1] === 14) {
    const low = sorted.slice(0, -1)
    const wheel = low.every((r, i) => (i === 0 ? r === 2 : r === low[i - 1]! + 1))
    if (wheel && low.length === len - 1) return low[low.length - 1]! // ace low → high card is the top of the low run
  }
  return null
}

// ---- three-card poker ----

/** 3-card category (higher = better). Note: a straight beats a flush (3-card rule). */
export enum ThreeCardCategory {
  HIGH_CARD = 0,
  PAIR = 1,
  FLUSH = 2,
  STRAIGHT = 3,
  TRIPS = 4,
  STRAIGHT_FLUSH = 5,
}

export interface ThreeCardRank {
  category: ThreeCardCategory
  /** comparable score: category dominates, then ordered ranks for ties. */
  score: bigint
}

/** Evaluate a 3-card hand into a comparable score. */
export function rankThreeCard(cards: number[]): ThreeCardRank {
  if (cards.length !== 3) throw new Error('rankThreeCard: need 3 cards')
  const counts = rankCounts(cards)
  const distinct = [...counts.keys()]
  const flush = isFlush(cards)
  const sHigh = distinct.length === 3 ? straightHigh(distinct, 3) : null
  const ranksDesc = cards.map(rankOf).sort((a, b) => b - a)

  let category: ThreeCardCategory
  let ordered: number[]
  if (counts.size === 1 || [...counts.values()].includes(3)) {
    category = ThreeCardCategory.TRIPS
    ordered = ranksDesc
  } else if (sHigh !== null && flush) {
    category = ThreeCardCategory.STRAIGHT_FLUSH
    ordered = [sHigh, 0, 0]
  } else if (sHigh !== null) {
    category = ThreeCardCategory.STRAIGHT
    ordered = [sHigh, 0, 0]
  } else if (flush) {
    category = ThreeCardCategory.FLUSH
    ordered = ranksDesc
  } else if ([...counts.values()].includes(2)) {
    category = ThreeCardCategory.PAIR
    const pairRank = [...counts.entries()].find(([, n]) => n === 2)![0]
    const kicker = [...counts.entries()].find(([, n]) => n === 1)![0]
    ordered = [pairRank, kicker, 0]
  } else {
    category = ThreeCardCategory.HIGH_CARD
    ordered = ranksDesc
  }
  // score: category * 15^3 + r1*15^2 + r2*15 + r3  (ranks ≤ 14 fit base-15 digits)
  const score = BigInt(category) * 3375n + BigInt(ordered[0]!) * 225n + BigInt(ordered[1]!) * 15n + BigInt(ordered[2]!)
  return { category, score }
}

// ---- five-card (Jacks-or-Better video poker) ----

export enum FiveCardCategory {
  NOTHING = 0,
  JACKS_OR_BETTER = 1,
  TWO_PAIR = 2,
  THREE_OF_A_KIND = 3,
  STRAIGHT = 4,
  FLUSH = 5,
  FULL_HOUSE = 6,
  FOUR_OF_A_KIND = 7,
  STRAIGHT_FLUSH = 8,
  ROYAL_FLUSH = 9,
}

/** Categorize a 5-card hand for the Jacks-or-Better paytable. */
export function rankFiveCard(cards: number[]): FiveCardCategory {
  if (cards.length !== 5) throw new Error('rankFiveCard: need 5 cards')
  const counts = rankCounts(cards)
  const countVals = [...counts.values()].sort((a, b) => b - a)
  const flush = isFlush(cards)
  const distinct = [...counts.keys()]
  const sHigh = distinct.length === 5 ? straightHigh(distinct, 5) : null

  if (flush && sHigh !== null) return sHigh === 14 ? FiveCardCategory.ROYAL_FLUSH : FiveCardCategory.STRAIGHT_FLUSH
  if (countVals[0] === 4) return FiveCardCategory.FOUR_OF_A_KIND
  if (countVals[0] === 3 && countVals[1] === 2) return FiveCardCategory.FULL_HOUSE
  if (flush) return FiveCardCategory.FLUSH
  if (sHigh !== null) return FiveCardCategory.STRAIGHT
  if (countVals[0] === 3) return FiveCardCategory.THREE_OF_A_KIND
  if (countVals[0] === 2 && countVals[1] === 2) return FiveCardCategory.TWO_PAIR
  if (countVals[0] === 2) {
    // a single pair pays only if the pair is Jacks or better (J=11, Q, K, A=14).
    const pairRank = [...counts.entries()].find(([, n]) => n === 2)![0]
    return pairRank >= 11 || pairRank === 14 ? FiveCardCategory.JACKS_OR_BETTER : FiveCardCategory.NOTHING
  }
  return FiveCardCategory.NOTHING
}
