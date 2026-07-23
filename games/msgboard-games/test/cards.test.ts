import { describe, it, expect } from 'vitest'
import {
  DECK_SIZE, rankOf, suitOf, cardName, shuffleDeck, baccaratValue, dragonTigerRank,
} from '../src/cards'

describe('cards: index convention', () => {
  it('rank/suit decode the index per (rank-2)*4 + suit', () => {
    expect(rankOf(0)).toBe(2)
    expect(suitOf(0)).toBe('clubs')
    expect(rankOf(51)).toBe(14) // ace
    expect(suitOf(51)).toBe('spades')
    expect(cardName(51)).toBe('A♠')
    expect(cardName(0)).toBe('2♣')
  })

  it('rejects out-of-range indices', () => {
    expect(() => rankOf(-1)).toThrow()
    expect(() => rankOf(52)).toThrow()
  })

  it('baccarat pip values: A=1, 2..9 face, 10/J/Q/K=0', () => {
    // ranks: index 48 = rank 14 (ace), 32 = rank 10, 36 = J, 40 = Q, 44 = K, 4 = rank 3
    expect(baccaratValue(48)).toBe(1) // ace
    expect(baccaratValue(4)).toBe(3)
    expect(baccaratValue(32)).toBe(0) // 10
    expect(baccaratValue(36)).toBe(0) // J
    expect(baccaratValue(44)).toBe(0) // K
  })

  it('dragon-tiger rank: ace low (1), 2..K = 2..13', () => {
    expect(dragonTigerRank(48)).toBe(1) // ace -> 1
    expect(dragonTigerRank(0)).toBe(2) // rank 2
    expect(dragonTigerRank(44)).toBe(13) // king
  })
})

describe('cards: seeded shuffle', () => {
  it('is a permutation of all 52 distinct cards', () => {
    for (const raw of [0n, 1n, 123456789n, 2n ** 255n, (2n ** 256n) - 1n]) {
      const deck = shuffleDeck(raw)
      expect(deck.length).toBe(DECK_SIZE)
      expect(new Set(deck).size).toBe(DECK_SIZE)
      expect([...deck].sort((a, b) => a - b)).toEqual(Array.from({ length: DECK_SIZE }, (_, i) => i))
    }
  })

  it('is deterministic in raw and varies across seeds', () => {
    expect(shuffleDeck(42n)).toEqual(shuffleDeck(42n))
    expect(shuffleDeck(42n)).not.toEqual(shuffleDeck(43n))
  })
})
