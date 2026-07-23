/**
 * Self-contained 52-card deck + seeded shuffle for the single-player card games (Baccarat, Dragon
 * Tiger, Andar Bahar). Dependency-light on purpose: msgboard-games is the clean off-chain layer, so
 * this does NOT import the ZK card stack in zk-core. The index convention matches zk-core/cards.ts:
 *
 *   index in [0, 51];  rank = floor(index/4) + 2  (2..14, ace HIGH);  suit = index % 4.
 *
 * `shuffleDeck(raw)` is a full Fisher–Yates over 52 driven by one round random. log2(52!) ≈ 225.6 bits,
 * so a 256-bit `raw` carries enough entropy for a full shuffle. The same `raw` always yields the same
 * order, and the algorithm is a plain uint256 loop — reproducible on-chain (a CardRules.sol mirror can
 * replay it with identical integer division). NOT mental poker: every dealt card is public, no other
 * player holds hidden state — fairness is "the deck was shuffled from the committed seed, not stacked".
 */
export const DECK_SIZE = 52

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const SUIT_GLYPH: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }
const RANK_GLYPH = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export function assertIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= DECK_SIZE) throw new Error(`card index out of range: ${i}`)
}

/** rank 2..14 (ace high); index = (rank-2)*4 + suit. */
export function rankOf(i: number): number {
  assertIndex(i)
  return Math.floor(i / 4) + 2
}
export function suitOf(i: number): Suit {
  assertIndex(i)
  return SUITS[i % 4]!
}
export function cardName(i: number): string {
  return `${RANK_GLYPH[rankOf(i) - 2]}${SUIT_GLYPH[suitOf(i)]}`
}

/**
 * Full Fisher–Yates shuffle of [0..51] driven by `raw`. Consumes base-(i+1) digits of `raw` from the
 * high end of the deck down, swapping deck[i] with deck[j], j = r % (i+1). Deterministic and
 * on-chain-reproducible (identical uint256 division order). Returns the 52 card indices in deal order
 * (deck[0] dealt first).
 */
export function shuffleDeck(raw: bigint): number[] {
  const deck: number[] = new Array(DECK_SIZE)
  for (let k = 0; k < DECK_SIZE; k++) deck[k] = k
  let r = raw
  for (let i = DECK_SIZE - 1; i >= 1; i--) {
    const window = BigInt(i + 1)
    const j = Number(r % window)
    r = r / window
    const tmp = deck[i]!
    deck[i] = deck[j]!
    deck[j] = tmp
  }
  return deck
}

/**
 * Baccarat pip value of a card: A=1, 2..9 face value, 10/J/Q/K = 0. (rank 2..9 → 2..9; rank 10..13 →
 * 0; rank 14 (ace) → 1.)
 */
export function baccaratValue(i: number): number {
  const rank = rankOf(i)
  if (rank === 14) return 1 // ace
  if (rank >= 10) return 0 // 10, J, Q, K
  return rank // 2..9
}

/** Dragon Tiger card rank: ace LOW (1); 2..K keep value 2..13. Used for the single-card high-card compare. */
export function dragonTigerRank(i: number): number {
  const rank = rankOf(i) // 2..14 (ace high)
  return rank === 14 ? 1 : rank // ace -> 1; 2..K (rank 2..13) unchanged
}
