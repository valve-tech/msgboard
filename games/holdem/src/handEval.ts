import { rankOf, suitOf } from '@msgboard/zk-cards-core'

/**
 * Texas Hold'em 5-of-7 hand evaluator — TS NORMATIVE reference.
 *
 * Mirrored bit-for-bit by `packages/contracts/contracts/zk/HoldemHandEval.sol` and
 * fuzz-parity-tested in `packages/contracts/test/HandEvalParity.test.ts`. Any divergence
 * mis-settles a disputed showdown, so the score encoding below is load-bearing and MUST stay
 * identical on both sides.
 *
 * ## Score encoding (a single comparable integer; higher = better)
 *   score = (category << 20) | (t1 << 16) | (t2 << 12) | (t3 << 8) | (t4 << 4) | t5
 * where:
 *   - `category` ∈ 0..8 (HIGH_CARD..STRAIGHT_FLUSH),
 *   - `t1..t5` are the ordered tiebreak ranks (each 2..14, i.e. 0x2..0xE — fits in 4 bits),
 *     laid out so a plain integer compare orders two hands correctly.
 *
 * Tiebreak layout per category (t1 most significant):
 *   HIGH_CARD     : the 5 ranks, high→low
 *   PAIR          : pair rank, then 3 kickers high→low
 *   TWO_PAIR      : high pair, low pair, kicker, 0, 0
 *   TRIPS         : trips rank, then 2 kickers high→low, 0, 0
 *   STRAIGHT      : straight high card (wheel A-2-3-4-5 ⇒ 5), 0,0,0,0
 *   FLUSH         : the 5 flush ranks high→low
 *   FULL_HOUSE    : trips rank, pair rank, 0,0,0
 *   QUADS         : quad rank, kicker, 0,0,0
 *   STRAIGHT_FLUSH: straight high card (wheel ⇒ 5), 0,0,0,0
 *
 * Best-5-of-7 is the max score over all C(7,5)=21 5-card subsets (simple + auditable; this
 * only runs in a disputed showdown, never on the happy path).
 */

export enum Category {
  HIGH_CARD = 0,
  PAIR = 1,
  TWO_PAIR = 2,
  TRIPS = 3,
  STRAIGHT = 4,
  FLUSH = 5,
  FULL_HOUSE = 6,
  QUADS = 7,
  STRAIGHT_FLUSH = 8,
}

/** Number of bits a tiebreak rank occupies; category sits above the 5 tiebreak nibbles. */
const CAT_SHIFT = 20n

/** Pack a category + up to 5 tiebreak ranks into the comparable score. */
function pack(category: Category, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0): bigint {
  return (
    (BigInt(category) << CAT_SHIFT) |
    (BigInt(t1) << 16n) |
    (BigInt(t2) << 12n) |
    (BigInt(t3) << 8n) |
    (BigInt(t4) << 4n) |
    BigInt(t5)
  )
}

/** Decode the category from a packed score. */
export function categoryOf(score: bigint): Category {
  return Number(score >> CAT_SHIFT) as Category
}

/**
 * Score a single, exactly-5-card hand. Suits only matter for flush/straight-flush detection;
 * everything else is rank-driven. Returns the packed comparable integer.
 */
export function score5(cards5: number[]): bigint {
  if (cards5.length !== 5) throw new Error('score5 expects exactly 5 cards')

  const ranks = cards5.map(rankOf) // 2..14
  const suits = cards5.map(suitOf)

  // Count occurrences per rank.
  const counts = new Map<number, number>()
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1)

  // Flush: all 5 same suit.
  const isFlush = suits.every((s) => s === suits[0])

  // Straight detection over the distinct ranks present. With 5 cards a straight needs 5
  // distinct ranks. Returns the straight's high card (wheel A-2-3-4-5 ⇒ 5), or 0 if none.
  const straightHigh = straightHighOf(ranks)

  // Ranks grouped by (count desc, rank desc) — the canonical tiebreak ordering.
  // e.g. trips+pair => [tripsRank(×3), pairRank(×2)]; we expand to the ordered tiebreak list.
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1] // higher count first
    return b[0] - a[0] // then higher rank
  })

  if (straightHigh > 0 && isFlush) {
    return pack(Category.STRAIGHT_FLUSH, straightHigh)
  }

  // Quads: a group of 4 + 1 kicker.
  if (groups[0]![1] === 4) {
    const quad = groups[0]![0]
    const kicker = groups[1]![0]
    return pack(Category.QUADS, quad, kicker)
  }

  // Full house: trips + pair.
  if (groups[0]![1] === 3 && groups[1]! && groups[1]![1] >= 2) {
    return pack(Category.FULL_HOUSE, groups[0]![0], groups[1]![0])
  }

  if (isFlush) {
    const desc = [...ranks].sort((a, b) => b - a)
    return pack(Category.FLUSH, desc[0], desc[1], desc[2], desc[3], desc[4])
  }

  if (straightHigh > 0) {
    return pack(Category.STRAIGHT, straightHigh)
  }

  // Trips (no full house): trips + 2 kickers.
  if (groups[0]![1] === 3) {
    return pack(Category.TRIPS, groups[0]![0], groups[1]![0], groups[2]![0])
  }

  // Two pair / one pair.
  if (groups[0]![1] === 2 && groups[1]! && groups[1]![1] === 2) {
    const hiPair = Math.max(groups[0]![0], groups[1]![0])
    const loPair = Math.min(groups[0]![0], groups[1]![0])
    const kicker = groups[2]![0]
    return pack(Category.TWO_PAIR, hiPair, loPair, kicker)
  }
  if (groups[0]![1] === 2) {
    return pack(Category.PAIR, groups[0]![0], groups[1]![0], groups[2]![0], groups[3]![0])
  }

  // High card.
  const desc = [...ranks].sort((a, b) => b - a)
  return pack(Category.HIGH_CARD, desc[0], desc[1], desc[2], desc[3], desc[4])
}

/**
 * If the 5 ranks form a straight, return its high card (wheel A-2-3-4-5 ⇒ 5); else 0.
 * Requires 5 distinct consecutive ranks; aces are high (14) but also low for the wheel.
 */
function straightHighOf(ranks: number[]): number {
  const distinct = [...new Set(ranks)]
  if (distinct.length !== 5) return 0
  const sorted = [...distinct].sort((a, b) => a - b)
  // Normal run of 5 consecutive ranks.
  if (sorted[4]! - sorted[0]! === 4) return sorted[4]!
  // Wheel: A,2,3,4,5 — present as {14,2,3,4,5}; high card is the 5.
  const wheel = [2, 3, 4, 5, 14]
  if (wheel.every((r, i) => sorted[i] === r)) return 5
  return 0
}

/** Index combinations C(7,5): all 21 5-subsets of indices 0..6. */
const COMBOS_7_5: number[][] = (() => {
  const out: number[][] = []
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++)
            out.push([a, b, c, d, e])
  return out
})()

/**
 * Evaluate the best 5-card hand out of 7 cards. `cards` is 7 DISTINCT deck indices (0..51):
 * a seat's 2 hole cards + the 5 community cards. Returns the comparable score.
 */
export function evaluate7(cards: number[]): bigint {
  if (cards.length !== 7) throw new Error('evaluate7 expects exactly 7 cards')
  let best = -1n
  for (const combo of COMBOS_7_5) {
    const s = score5(combo.map((i) => cards[i]!))
    if (s > best) best = s
  }
  return best
}

export interface EvalResult {
  /** The comparable score (== evaluate7(cards)). */
  score: bigint
  /** The hand category of the best 5. */
  category: Category
  /** The best-5 card indices (a subset of the input 7), in input order. */
  best: number[]
}

/**
 * Like `evaluate7` but also returns the winning best-5 subset + category — the shape Task 7's
 * showdown settlement consumes (total order over seats, ties detectable via equal `score`).
 */
export function evaluate7Full(cards: number[]): EvalResult {
  if (cards.length !== 7) throw new Error('evaluate7Full expects exactly 7 cards')
  let best = -1n
  let bestCombo = COMBOS_7_5[0]!
  for (const combo of COMBOS_7_5) {
    const s = score5(combo.map((i) => cards[i]!))
    if (s > best) {
      best = s
      bestCombo = combo
    }
  }
  return { score: best, category: categoryOf(best), best: bestCombo.map((i) => cards[i]!) }
}

/** Sign of evaluate7(a) − evaluate7(b): >0 a wins, <0 b wins, 0 split. A total order. */
export function compareHands(a: number[], b: number[]): number {
  const da = evaluate7(a)
  const db = evaluate7(b)
  return da > db ? 1 : da < db ? -1 : 0
}
