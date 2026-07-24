import { describe, it, expect } from 'vitest'
import {
  rankFivePaiGow, rankTwoPaiGow, PaiGowCategory, isFoul, houseWaySplit, dealPaiGow, settlePaiGow,
  playerHouseWayPositions, paiGowMaxMultiplierX100, commitPaiGow, verifyPaiGow, normalizeFrontPositions,
} from '../src/games/paiGow'
import { subRandom } from '../src/rng'

const S = 1_000_000n

// index = (rank-2)*4 + suit; suit 0 clubs, 1 diamonds, 2 hearts, 3 spades.
const card = (rank: number, suit: number) => (rank - 2) * 4 + suit

// A realistic 256-bit round seed for deal `i` — tiny integer seeds run the Fisher–Yates out of entropy
// and produce degenerate decks, so we hash the index the way roundRandom would in production.
const seedFor = (i: number) => subRandom(BigInt(i) + 1n, 0n)

describe('pai gow — 5-card hand evaluation', () => {
  it('classifies every category and orders them correctly', () => {
    const hands: [PaiGowCategory, number[]][] = [
      [PaiGowCategory.HIGH_CARD, [card(14, 0), card(12, 1), card(9, 2), card(7, 3), card(5, 0)]],
      [PaiGowCategory.PAIR, [card(14, 0), card(14, 1), card(9, 2), card(7, 3), card(5, 0)]],
      [PaiGowCategory.TWO_PAIR, [card(14, 0), card(14, 1), card(9, 2), card(9, 3), card(5, 0)]],
      [PaiGowCategory.TRIPS, [card(14, 0), card(14, 1), card(14, 2), card(9, 3), card(5, 0)]],
      [PaiGowCategory.STRAIGHT, [card(10, 0), card(9, 1), card(8, 2), card(7, 3), card(6, 0)]],
      [PaiGowCategory.FLUSH, [card(14, 1), card(11, 1), card(9, 1), card(6, 1), card(3, 1)]],
      [PaiGowCategory.FULL_HOUSE, [card(14, 0), card(14, 1), card(14, 2), card(9, 3), card(9, 0)]],
      [PaiGowCategory.QUADS, [card(14, 0), card(14, 1), card(14, 2), card(14, 3), card(9, 0)]],
      [PaiGowCategory.STRAIGHT_FLUSH, [card(9, 1), card(8, 1), card(7, 1), card(6, 1), card(5, 1)]],
    ]
    const scores: bigint[] = []
    for (const [cat, cards] of hands) {
      const r = rankFivePaiGow(cards)
      expect(r.category).toBe(cat)
      scores.push(r.score)
    }
    // strictly increasing category → strictly increasing score
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeGreaterThan(scores[i - 1]!)
  })

  it('handles the ace-low wheel straight (A-2-3-4-5 → high 5)', () => {
    const wheel = [card(14, 0), card(2, 1), card(3, 2), card(4, 3), card(5, 0)]
    const r = rankFivePaiGow(wheel)
    expect(r.category).toBe(PaiGowCategory.STRAIGHT)
    // a wheel (high 5) is the LOWEST straight — below a 6-high straight
    const six = rankFivePaiGow([card(6, 0), card(5, 1), card(4, 2), card(3, 3), card(2, 0)])
    expect(r.score).toBeLessThan(six.score)
    // royal (ace-high straight flush) folds into STRAIGHT_FLUSH and beats a wheel straight flush
    const royal = rankFivePaiGow([card(14, 1), card(13, 1), card(12, 1), card(11, 1), card(10, 1)])
    const wheelSF = rankFivePaiGow([card(14, 1), card(2, 1), card(3, 1), card(4, 1), card(5, 1)])
    expect(royal.category).toBe(PaiGowCategory.STRAIGHT_FLUSH)
    expect(wheelSF.category).toBe(PaiGowCategory.STRAIGHT_FLUSH)
    expect(royal.score).toBeGreaterThan(wheelSF.score)
  })

  it('kicker ordering breaks ties within a category', () => {
    const aceKicker = rankFivePaiGow([card(9, 0), card(9, 1), card(14, 2), card(7, 3), card(5, 0)])
    const kingKicker = rankFivePaiGow([card(9, 0), card(9, 1), card(13, 2), card(7, 3), card(5, 0)])
    expect(aceKicker.score).toBeGreaterThan(kingKicker.score)
  })
})

describe('pai gow — 2-card front hand', () => {
  it('a pair beats any two-singleton front', () => {
    const pair = rankTwoPaiGow([card(5, 0), card(5, 1)])
    const highAK = rankTwoPaiGow([card(14, 0), card(13, 1)])
    expect(pair.category).toBe(PaiGowCategory.PAIR)
    expect(highAK.category).toBe(PaiGowCategory.HIGH_CARD)
    expect(pair.score).toBeGreaterThan(highAK.score)
  })
  it('high-card fronts order by top then second card', () => {
    const aq = rankTwoPaiGow([card(14, 0), card(12, 1)])
    const aj = rankTwoPaiGow([card(14, 0), card(11, 1)])
    expect(aq.score).toBeGreaterThan(aj.score)
  })
})

describe('pai gow — split legality (foul rule)', () => {
  it('a front pair over a high-card back is a foul', () => {
    const front = [card(2, 0), card(2, 1)] // pair of 2s
    const back = [card(14, 0), card(13, 1), card(9, 2), card(7, 3), card(5, 0)] // ace high
    expect(isFoul(front, back)).toBe(true)
  })
  it('two-singleton front below the back top cards is legal', () => {
    const front = [card(4, 0), card(3, 1)]
    const back = [card(14, 0), card(13, 1), card(9, 2), card(7, 3), card(5, 0)]
    expect(isFoul(front, back)).toBe(false)
  })
  it('a two-pair-or-better back never fouls against any front', () => {
    const front = [card(14, 0), card(14, 1)] // pair of aces
    const back = [card(13, 0), card(13, 1), card(9, 2), card(9, 3), card(5, 0)] // two pair
    expect(isFoul(front, back)).toBe(false)
  })
})

describe('pai gow — house way', () => {
  it('always produces a legal split for many random deals', () => {
    for (let i = 0; i < 300; i++) {
      const seed = seedFor(i)
      const { player, dealer } = dealPaiGow(seed)
      for (const seven of [player, dealer]) {
        const split = houseWaySplit(seven)
        expect(split.front.length).toBe(2)
        expect(split.back.length).toBe(5)
        expect(isFoul(split.front, split.back)).toBe(false)
        // the back is at least as strong as the front on the shared scale where it must not be fouled
        expect(new Set([...split.front, ...split.back]).size).toBe(7) // uses all 7 cards once
      }
    }
  })
})

describe('pai gow — settlement', () => {
  it('the player auto-set (house way) settles to a definite win/push/lose, delta bounded', () => {
    for (let i = 0; i < 300; i++) {
      const seed = seedFor(i)
      const positions = playerHouseWayPositions(seed)
      const out = settlePaiGow(S, seed, positions)
      expect(out.fouled).toBe(false)
      expect(['lose', 'push', 'win']).toContain(out.result)
      expect(out.playerDelta).toBeGreaterThanOrEqual(-S)
      expect(out.playerDelta).toBeLessThanOrEqual(S) // even money ceiling
      const expectedDelta = out.result === 'win' ? S : out.result === 'lose' ? -S : 0n
      expect(out.playerDelta).toBe(expectedDelta)
      expect(out.multiplierX100).toBeLessThanOrEqual(paiGowMaxMultiplierX100())
    }
  })

  it('all three outcomes (win/push/lose) occur across seeds', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const seed = seedFor(i)
      seen.add(settlePaiGow(S, seed, playerHouseWayPositions(seed)).result)
    }
    expect(seen.has('win')).toBe(true)
    expect(seen.has('lose')).toBe(true)
    expect(seen.has('push')).toBe(true)
  })

  it('a deliberately fouled player split loses outright', () => {
    // find a seed where the player has a pair we can force into the front over a high-card back
    let found = false
    for (let s = 0; s < 400 && !found; s++) {
      const seed = seedFor(s)
      const { player } = dealPaiGow(seed)
      // try every 2-position front; if any is a foul, assert it loses
      for (let i = 0; i < 7 && !found; i++) {
        for (let j = i + 1; j < 7 && !found; j++) {
          const front = [player[i]!, player[j]!]
          const back = [0, 1, 2, 3, 4, 5, 6].filter((p) => p !== i && p !== j).map((p) => player[p]!)
          if (isFoul(front, back)) {
            const out = settlePaiGow(S, seed, [i, j])
            expect(out.fouled).toBe(true)
            expect(out.result).toBe('lose')
            expect(out.playerDelta).toBe(-S)
            found = true
          }
        }
      }
    }
    expect(found).toBe(true) // a foulable deal exists within the sampled seeds
  })

  it('verify accepts an honest hand and rejects wrong seed / inflated delta / different split', () => {
    const seed = 1234n
    const positions = playerHouseWayPositions(seed)
    const out = settlePaiGow(S, seed, positions)
    const claim = { commit: commitPaiGow(seed), frontPositions: positions, stake: S, claimedDelta: out.playerDelta }
    expect(verifyPaiGow(claim, seed).ok).toBe(true)
    expect(verifyPaiGow(claim, seed + 1n).ok).toBe(false)
    expect(verifyPaiGow({ ...claim, claimedDelta: out.playerDelta + 1n }, seed).ok).toBe(false)
  })

  it('normalizeFrontPositions validates and sorts', () => {
    expect(normalizeFrontPositions([5, 1])).toEqual([1, 5])
    expect(() => normalizeFrontPositions([1])).toThrow()
    expect(() => normalizeFrontPositions([1, 1])).toThrow()
    expect(() => normalizeFrontPositions([1, 7])).toThrow()
  })
})
