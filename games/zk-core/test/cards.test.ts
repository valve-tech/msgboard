import { describe, it, expect } from 'vitest'
import { cardFromIndex, rankOf, suitOf, compareRanks, cardName, DECK_SIZE } from '../src/cards'

describe('card codec', () => {
  it('decodes all 52 indices uniquely', () => {
    expect(DECK_SIZE).toBe(52)
    const seen = new Set<string>()
    for (let i = 0; i < 52; i++) {
      const c = cardFromIndex(i)
      expect(c.rank).toBeGreaterThanOrEqual(2)
      expect(c.rank).toBeLessThanOrEqual(14)
      expect(['clubs', 'diamonds', 'hearts', 'spades']).toContain(c.suit)
      seen.add(`${c.rank}-${c.suit}`)
    }
    expect(seen.size).toBe(52)
  })
  it('rank layout: index = (rank-2)*4 + suitIndex', () => {
    expect(rankOf(0)).toBe(2)            // 2 of clubs
    expect(rankOf(51)).toBe(14)          // ace of spades
    expect(suitOf(0)).toBe('clubs')
    expect(suitOf(51)).toBe('spades')
  })
  it('compares ace-high, suits irrelevant', () => {
    expect(compareRanks(51, 0)).toBeGreaterThan(0)   // A > 2
    expect(compareRanks(0, 1)).toBe(0)               // 2c vs 2d tie
    expect(compareRanks(4, 51)).toBeLessThan(0)      // 3 < A
  })
  it('names cards', () => {
    expect(cardName(51)).toBe('A♠')
    expect(cardName(0)).toBe('2♣')
  })
  it('rejects out-of-range indices', () => {
    expect(() => cardFromIndex(52)).toThrow()
    expect(() => cardFromIndex(-1)).toThrow()
  })
})
