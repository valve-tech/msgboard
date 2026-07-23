import { describe, it, expect } from 'vitest'
import { rankThreeCard, ThreeCardCategory, rankFiveCard, FiveCardCategory } from '../src/poker'

// card index = (rank-2)*4 + suit; suit 0=clubs..3=spades. Helper to build a card.
const card = (rank: number, suit: number): number => (rank - 2) * 4 + suit

describe('three-card hand ranking', () => {
  it('classifies each category and orders straight above flush', () => {
    // straight flush: 5-6-7 of clubs
    expect(rankThreeCard([card(5, 0), card(6, 0), card(7, 0)]).category).toBe(ThreeCardCategory.STRAIGHT_FLUSH)
    // trips: three 9s
    expect(rankThreeCard([card(9, 0), card(9, 1), card(9, 2)]).category).toBe(ThreeCardCategory.TRIPS)
    // straight (mixed suits) 5-6-7
    expect(rankThreeCard([card(5, 0), card(6, 1), card(7, 2)]).category).toBe(ThreeCardCategory.STRAIGHT)
    // flush (not straight): 2-5-9 clubs
    expect(rankThreeCard([card(2, 0), card(5, 0), card(9, 0)]).category).toBe(ThreeCardCategory.FLUSH)
    // pair of kings
    expect(rankThreeCard([card(13, 0), card(13, 1), card(4, 2)]).category).toBe(ThreeCardCategory.PAIR)
    // high card
    expect(rankThreeCard([card(2, 0), card(7, 1), card(13, 2)]).category).toBe(ThreeCardCategory.HIGH_CARD)
    // straight (cat 3) outranks flush (cat 2)
    const straight = rankThreeCard([card(5, 0), card(6, 1), card(7, 2)])
    const flush = rankThreeCard([card(2, 0), card(5, 0), card(9, 0)])
    expect(straight.score).toBeGreaterThan(flush.score)
  })

  it('treats A-2-3 as a straight (wheel)', () => {
    expect(rankThreeCard([card(14, 0), card(2, 1), card(3, 2)]).category).toBe(ThreeCardCategory.STRAIGHT)
  })

  it('a higher pair beats a lower pair', () => {
    const aces = rankThreeCard([card(14, 0), card(14, 1), card(2, 2)])
    const kings = rankThreeCard([card(13, 0), card(13, 1), card(14, 2)])
    expect(aces.score).toBeGreaterThan(kings.score)
  })
})

describe('five-card (Jacks-or-Better) ranking', () => {
  it('classifies the paytable categories', () => {
    expect(rankFiveCard([card(10, 0), card(11, 0), card(12, 0), card(13, 0), card(14, 0)])).toBe(FiveCardCategory.ROYAL_FLUSH)
    expect(rankFiveCard([card(5, 0), card(6, 0), card(7, 0), card(8, 0), card(9, 0)])).toBe(FiveCardCategory.STRAIGHT_FLUSH)
    expect(rankFiveCard([card(9, 0), card(9, 1), card(9, 2), card(9, 3), card(2, 0)])).toBe(FiveCardCategory.FOUR_OF_A_KIND)
    expect(rankFiveCard([card(9, 0), card(9, 1), card(9, 2), card(2, 0), card(2, 1)])).toBe(FiveCardCategory.FULL_HOUSE)
    expect(rankFiveCard([card(2, 0), card(5, 0), card(9, 0), card(11, 0), card(13, 0)])).toBe(FiveCardCategory.FLUSH)
    expect(rankFiveCard([card(5, 0), card(6, 1), card(7, 2), card(8, 3), card(9, 0)])).toBe(FiveCardCategory.STRAIGHT)
    expect(rankFiveCard([card(9, 0), card(9, 1), card(9, 2), card(4, 0), card(2, 1)])).toBe(FiveCardCategory.THREE_OF_A_KIND)
    expect(rankFiveCard([card(9, 0), card(9, 1), card(4, 0), card(4, 1), card(2, 0)])).toBe(FiveCardCategory.TWO_PAIR)
    // pair of jacks pays; pair of tens does not
    expect(rankFiveCard([card(11, 0), card(11, 1), card(4, 0), card(7, 1), card(2, 0)])).toBe(FiveCardCategory.JACKS_OR_BETTER)
    expect(rankFiveCard([card(10, 0), card(10, 1), card(4, 0), card(7, 1), card(2, 0)])).toBe(FiveCardCategory.NOTHING)
  })

  it('A-2-3-4-5 is a (wheel) straight', () => {
    expect(rankFiveCard([card(14, 0), card(2, 1), card(3, 2), card(4, 3), card(5, 0)])).toBe(FiveCardCategory.STRAIGHT)
  })
})
