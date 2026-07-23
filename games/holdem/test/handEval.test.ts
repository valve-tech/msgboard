import { describe, it, expect } from 'vitest'
import { rankOf, suitOf, type Suit } from '@msgboard/zk-cards-core'
import {
  evaluate7,
  compareHands,
  Category,
  categoryOf,
  type EvalResult,
  evaluate7Full,
} from '../src/handEval'

// --- Card helpers -----------------------------------------------------------
// index = (rank-2)*4 + suit, rank 2..14 (ace high). suit order: clubs,diamonds,hearts,spades.
const SUIT_IDX: Record<Suit, number> = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 }
/** Build a card index from a 2..14 rank + suit name. */
function card(rank: number, suit: Suit): number {
  return (rank - 2) * 4 + SUIT_IDX[suit]
}
/** Parse "As" / "Td" / "2c" style strings into a card index. */
function C(s: string): number {
  const RANKS: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14,
  }
  const SUITS: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }
  const r = RANKS[s[0]!]!
  const su = SUITS[s[1]!]!
  return card(r, su)
}
function hand(...ss: string[]): number[] {
  return ss.map(C)
}

describe('handEval — card helpers sanity', () => {
  it('round-trips rank/suit through the index encoding', () => {
    expect(rankOf(C('As'))).toBe(14)
    expect(suitOf(C('As'))).toBe('spades')
    expect(rankOf(C('2c'))).toBe(2)
    expect(suitOf(C('2c'))).toBe('clubs')
  })
})

describe('handEval — category recognition (best 5 of 7)', () => {
  const cat = (cards: number[]): Category => categoryOf(evaluate7(cards))

  it('high card', () => {
    expect(cat(hand('Ad', 'Qh', '9s', '7c', '5d', '3h', '2s'))).toBe(Category.HIGH_CARD)
  })
  it('one pair', () => {
    expect(cat(hand('Ad', 'Ah', '9s', '7c', '5d', '3h', '2s'))).toBe(Category.PAIR)
  })
  it('two pair', () => {
    expect(cat(hand('Ad', 'Ah', '9s', '9c', '5d', '3h', '2s'))).toBe(Category.TWO_PAIR)
  })
  it('trips', () => {
    expect(cat(hand('Ad', 'Ah', 'As', '9c', '5d', '3h', '2s'))).toBe(Category.TRIPS)
  })
  it('straight', () => {
    expect(cat(hand('Td', '9h', '8s', '7c', '6d', '2h', '2s'))).toBe(Category.STRAIGHT)
  })
  it('wheel straight (A-2-3-4-5) is a straight', () => {
    expect(cat(hand('Ad', '2h', '3s', '4c', '5d', 'Kh', 'Qs'))).toBe(Category.STRAIGHT)
  })
  it('flush', () => {
    expect(cat(hand('Ad', 'Jd', '9d', '6d', '3d', 'Kh', '2s'))).toBe(Category.FLUSH)
  })
  it('full house', () => {
    expect(cat(hand('Ad', 'Ah', 'As', '9c', '9d', '3h', '2s'))).toBe(Category.FULL_HOUSE)
  })
  it('quads', () => {
    expect(cat(hand('Ad', 'Ah', 'As', 'Ac', '9d', '3h', '2s'))).toBe(Category.QUADS)
  })
  it('straight flush', () => {
    expect(cat(hand('9d', '8d', '7d', '6d', '5d', 'Kh', '2s'))).toBe(Category.STRAIGHT_FLUSH)
  })
  it('royal flush is a straight flush', () => {
    expect(cat(hand('Ad', 'Kd', 'Qd', 'Jd', 'Td', '3h', '2s'))).toBe(Category.STRAIGHT_FLUSH)
  })
  it('wheel straight flush (A-2-3-4-5 same suit)', () => {
    expect(cat(hand('Ad', '2d', '3d', '4d', '5d', 'Kh', 'Qs'))).toBe(Category.STRAIGHT_FLUSH)
  })
})

describe('handEval — category ordering', () => {
  const score = (cards: number[]) => evaluate7(cards)
  it('each category outranks the one below it', () => {
    const ordered = [
      hand('Ad', 'Qh', '9s', '7c', '5d', '3h', '2s'), // high card
      hand('2d', '2h', '9s', '7c', '5d', '3h', 'Js'), // pair
      hand('2d', '2h', '9s', '9c', '5d', '3h', 'Js'), // two pair
      hand('2d', '2h', '2s', '9c', '5d', '3h', 'Js'), // trips
      hand('Td', '9h', '8s', '7c', '6d', '2h', '2s'), // straight
      hand('Ad', 'Jd', '9d', '6d', '3d', 'Kh', '2s'), // flush
      hand('2d', '2h', '2s', '9c', '9d', '3h', 'Js'), // full house
      hand('2d', '2h', '2s', '2c', '9d', '3h', 'Js'), // quads
      hand('9d', '8d', '7d', '6d', '5d', 'Kh', '2s'), // straight flush
    ]
    for (let i = 1; i < ordered.length; i++) {
      expect(score(ordered[i]!) > score(ordered[i - 1]!), `cat ${i} > cat ${i - 1}`).toBe(true)
    }
  })
  it('straight flush beats quads', () => {
    const sf = hand('9d', '8d', '7d', '6d', '5d', 'Kh', 'Qs')
    const quads = hand('Ad', 'Ah', 'As', 'Ac', 'Kd', '3h', '2s')
    expect(score(sf) > score(quads)).toBe(true)
  })
  it('flush beats straight', () => {
    const flush = hand('2d', '4d', '6d', '8d', 'Td', 'Ah', 'Ks')
    const straight = hand('Td', '9h', '8s', '7c', '6d', '2h', '3s')
    expect(score(flush) > score(straight)).toBe(true)
  })
})

describe('handEval — kickers & within-category tiebreaks', () => {
  const score = (cards: number[]) => evaluate7(cards)
  it('two pair: same pairs, higher kicker wins', () => {
    const aceKick = hand('Kd', 'Kh', '9s', '9c', 'Ad', '3h', '2s')
    const tenKick = hand('Kd', 'Kh', '9s', '9c', 'Td', '3h', '2s')
    expect(score(aceKick) > score(tenKick)).toBe(true)
  })
  it('higher pair wins over lower pair', () => {
    const aces = hand('Ad', 'Ah', '9s', '7c', '5d', '3h', '2s')
    const kings = hand('Kd', 'Kh', '9s', '7c', '5d', '3h', '2s')
    expect(score(aces) > score(kings)).toBe(true)
  })
  it('one pair: kicker ladder breaks ties', () => {
    const hi = hand('Ad', 'Ah', 'Ks', 'Qc', '5d', '3h', '2s')
    const lo = hand('Ad', 'Ah', 'Ks', 'Jc', '5d', '3h', '2s')
    expect(score(hi) > score(lo)).toBe(true)
  })
  it('higher straight beats lower straight', () => {
    const big = hand('Td', '9h', '8s', '7c', '6d', '2h', '3s')
    const small = hand('6d', '5h', '4s', '3c', '2d', 'Kh', 'Qs')
    expect(score(big) > score(small)).toBe(true)
  })
  it('wheel is the LOWEST straight (A-2-3-4-5 < 2-3-4-5-6)', () => {
    const wheel = hand('Ad', '2h', '3s', '4c', '5d', 'Kh', 'Qs')
    const six = hand('6d', '5h', '4s', '3c', '2d', 'Kh', 'Qs')
    expect(score(six) > score(wheel)).toBe(true)
  })
  it('full house: higher trips wins, then higher pair', () => {
    const aaaKK = hand('Ad', 'Ah', 'As', 'Kc', 'Kd', '3h', '2s')
    const kkkAA = hand('Kd', 'Kh', 'Ks', 'Ac', 'Ad', '3h', '2s')
    expect(score(aaaKK) > score(kkkAA)).toBe(true)
    const aaaKKvAAQQ = hand('Ad', 'Ah', 'As', 'Qc', 'Qd', '3h', '2s')
    expect(score(aaaKK) > score(aaaKKvAAQQ)).toBe(true)
  })
  it('flush high-card ladder breaks flush ties', () => {
    const aHigh = hand('Ad', 'Jd', '9d', '6d', '3d', 'Kh', '2s')
    const kHigh = hand('Kd', 'Jd', '9d', '6d', '3d', 'Ah', '2s')
    expect(score(aHigh) > score(kHigh)).toBe(true)
  })
})

describe('handEval — tie detection (split pots)', () => {
  it('identical best-5 from different suits score EQUAL', () => {
    // Both seats play the board: A-K-Q-J-T straight (broadway), holes irrelevant.
    const board = ['Ad', 'Kh', 'Qs', 'Jc', 'Td']
    const a = hand(...board, '2c', '3h')
    const b = hand(...board, '4s', '5d')
    expect(evaluate7(a)).toBe(evaluate7(b))
    expect(compareHands(a, b)).toBe(0)
  })
  it('same pair + same kickers, different suits = tie', () => {
    const a = hand('Ad', 'Ah', 'Ks', 'Qc', 'Jd', '3h', '2s')
    const b = hand('Ac', 'As', 'Kd', 'Qh', 'Jc', '4h', '5s')
    expect(evaluate7(a)).toBe(evaluate7(b))
  })
})

describe('handEval — compareHands total order', () => {
  it('antisymmetric on a sampled set', () => {
    const samples = [
      hand('Ad', 'Ah', 'As', 'Ac', '9d', '3h', '2s'),
      hand('9d', '8d', '7d', '6d', '5d', 'Kh', '2s'),
      hand('Ad', 'Qh', '9s', '7c', '5d', '3h', '2s'),
      hand('2d', '2h', '9s', '9c', '5d', '3h', 'Js'),
    ]
    for (const x of samples)
      for (const y of samples)
        // `+ 0` normalizes -0 (from -Math.sign(0)) so toBe's Object.is doesn't trip on 0 vs -0.
        expect(Math.sign(compareHands(x, y))).toBe(-Math.sign(compareHands(y, x)) + 0)
  })
  it('transitive on a sampled set', () => {
    const samples = [
      hand('Ad', 'Ah', 'As', 'Ac', '9d', '3h', '2s'), // quads
      hand('2d', '2h', '2s', '9c', '9d', '3h', 'Js'), // full house
      hand('Td', '9h', '8s', '7c', '6d', '2h', '2s'), // straight
      hand('Ad', 'Qh', '9s', '7c', '5d', '3h', '2s'), // high card
    ]
    for (const a of samples)
      for (const b of samples)
        for (const c of samples) {
          if (compareHands(a, b) >= 0 && compareHands(b, c) >= 0) {
            expect(compareHands(a, c) >= 0).toBe(true)
          }
        }
  })
})

describe('handEval — known reference hands', () => {
  const cases: { name: string; cards: number[]; cat: Category }[] = [
    { name: 'royal flush', cards: hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d'), cat: Category.STRAIGHT_FLUSH },
    { name: 'quad aces', cards: hand('As', 'Ah', 'Ad', 'Ac', 'Ks', '2c', '3d'), cat: Category.QUADS },
    { name: 'boat (KKKQQ)', cards: hand('Ks', 'Kh', 'Kd', 'Qc', 'Qs', '2c', '3d'), cat: Category.FULL_HOUSE },
    { name: 'nut flush', cards: hand('As', 'Ks', 'Qs', '9s', '2s', '5c', '7d'), cat: Category.FLUSH },
    { name: 'broadway straight', cards: hand('As', 'Kh', 'Qd', 'Jc', 'Ts', '2c', '3d'), cat: Category.STRAIGHT },
    { name: 'set of 7s', cards: hand('7s', '7h', '7d', 'Kc', 'Qs', '2c', '3d'), cat: Category.TRIPS },
    { name: 'aces up', cards: hand('As', 'Ah', 'Kd', 'Kc', 'Qs', '2c', '3d'), cat: Category.TWO_PAIR },
    { name: 'pair of jacks', cards: hand('Js', 'Jh', 'Kd', '9c', 'Qs', '2c', '3d'), cat: Category.PAIR },
    { name: 'ace high', cards: hand('As', 'Jh', '9d', '7c', '5s', '3c', '2d'), cat: Category.HIGH_CARD },
  ]
  for (const c of cases) {
    it(`${c.name} -> ${Category[c.cat]}`, () => {
      expect(categoryOf(evaluate7(c.cards))).toBe(c.cat)
    })
  }
})

describe('handEval — full result shape (usable by Task 7)', () => {
  it('evaluate7Full returns the same score plus best-5 + category', () => {
    const cards = hand('9d', '8d', '7d', '6d', '5d', 'Kh', '2s')
    const full: EvalResult = evaluate7Full(cards)
    expect(full.score).toBe(evaluate7(cards))
    expect(full.category).toBe(Category.STRAIGHT_FLUSH)
    expect(full.best.length).toBe(5)
    // best-5 are all from the input
    for (const c of full.best) expect(cards).toContain(c)
  })
})
