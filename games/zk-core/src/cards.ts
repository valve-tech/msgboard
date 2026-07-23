export const DECK_SIZE = 52
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const SUIT_GLYPH: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }
const RANK_GLYPH = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export interface Card { index: number; rank: number; suit: Suit }

function assertIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= DECK_SIZE) throw new Error(`card index out of range: ${i}`)
}
/** rank 2..14 (ace high); index = (rank-2)*4 + suit */
export function rankOf(i: number): number { assertIndex(i); return Math.floor(i / 4) + 2 }
export function suitOf(i: number): Suit { assertIndex(i); return SUITS[i % 4]! }
export function cardFromIndex(i: number): Card { return { index: i, rank: rankOf(i), suit: suitOf(i) } }
/** >0 if a outranks b, <0 if b outranks a, 0 on equal rank (suits never break ties) */
export function compareRanks(a: number, b: number): number { return rankOf(a) - rankOf(b) }
export function cardName(i: number): string { return `${RANK_GLYPH[rankOf(i) - 2]}${SUIT_GLYPH[suitOf(i)]}` }
