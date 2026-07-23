import { describe, it, expect } from 'vitest'
import { buildSidePots, splitPot } from '../src/sidePots'

// Σ of every pot's amount — the conservation quantity that must equal Σ totalContributed.
const sumPots = (pots: { amount: bigint; eligible: number[] }[]): bigint =>
  pots.reduce((acc, p) => acc + p.amount, 0n)
const sumContrib = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

describe('buildSidePots — standard all-in side-pot algorithm', () => {
  it('(a) no all-in: a single main pot, every non-folded seat eligible', () => {
    const contrib = [10n, 10n, 10n]
    const folded = [false, false, false]
    const pots = buildSidePots(contrib, folded)
    expect(pots).toHaveLength(1)
    expect(pots[0]!.amount).toBe(30n)
    expect(pots[0]!.eligible).toEqual([0, 1, 2])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('(b) one short all-in: main pot capped at the all-in level, side pot for the rest', () => {
    // seat 0 all-in for 5, seats 1 & 2 in for 20.
    const contrib = [5n, 20n, 20n]
    const folded = [false, false, false]
    const pots = buildSidePots(contrib, folded)
    // layer 1 (level 5): 3 seats * 5 = 15, all eligible
    // layer 2 (level 20): 2 seats * 15 = 30, seats 1 & 2 eligible
    expect(pots).toHaveLength(2)
    expect(pots[0]!.amount).toBe(15n)
    expect(pots[0]!.eligible).toEqual([0, 1, 2])
    expect(pots[1]!.amount).toBe(30n)
    expect(pots[1]!.eligible).toEqual([1, 2])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('(c) multiple all-ins at different levels: N layered pots, eligibility shrinking', () => {
    // seat0 all-in 5, seat1 all-in 15, seat2 & seat3 in for 40.
    const contrib = [5n, 15n, 40n, 40n]
    const folded = [false, false, false, false]
    const pots = buildSidePots(contrib, folded)
    // level 5: 4*5 = 20, eligible {0,1,2,3}
    // level 15: 3*10 = 30, eligible {1,2,3}
    // level 40: 2*25 = 50, eligible {2,3}
    expect(pots).toHaveLength(3)
    expect(pots[0]!.amount).toBe(20n)
    expect(pots[0]!.eligible).toEqual([0, 1, 2, 3])
    expect(pots[1]!.amount).toBe(30n)
    expect(pots[1]!.eligible).toEqual([1, 2, 3])
    expect(pots[2]!.amount).toBe(50n)
    expect(pots[2]!.eligible).toEqual([2, 3])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('(d) folded contributors leave their chips in the pots but are NOT eligible', () => {
    // seat 1 folded after putting in 10 (e.g. called then folded a later street's bet).
    const contrib = [30n, 10n, 30n]
    const folded = [false, true, false]
    const pots = buildSidePots(contrib, folded)
    // level 10: 3*10 = 30, eligible {0,2} (seat1 folded, ineligible though its chips counted)
    // level 30: 2*20 = 40, eligible {0,2}
    // Both layers have the SAME eligible set {0,2} (seat1's all-in level didn't create a
    // live split) -> they MERGE into one pot of 70. A separate side pot only forms when
    // eligibility actually shrinks among LIVE seats.
    expect(pots).toHaveLength(1)
    expect(pots[0]!.amount).toBe(70n)
    expect(pots[0]!.eligible).toEqual([0, 2])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('(d3) a folded seat at a distinct level DOES split when a live seat is capped there', () => {
    // seat0 live all-in 10, seat1 folded at 20, seat2 live 20.
    // level 10: 3*10=30 eligible {0,2}; level 20: 2*10=20 eligible {2} (seat1 folded, seat0
    // capped at 10) -> two pots, the upper contested only by seat2.
    const contrib = [10n, 20n, 20n]
    const folded = [false, true, false]
    const pots = buildSidePots(contrib, folded)
    expect(pots).toHaveLength(2)
    expect(pots[0]!.amount).toBe(30n)
    expect(pots[0]!.eligible).toEqual([0, 2])
    expect(pots[1]!.amount).toBe(20n)
    expect(pots[1]!.eligible).toEqual([2])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('(d2) a folded seat that out-contributed everyone still forfeits all chips to the pots', () => {
    // seat 0 bet big then folded to a re-raise; its uncalled excess is its own — but here
    // everyone matched up to 20, seat0 folded having put in 50: only the matched portion can
    // be in pots; the uncalled 30 must be RETURNED, not forfeited. Modeled by returnUncalled.
    const contrib = [50n, 20n, 20n]
    const folded = [true, false, false]
    // buildSidePots operates on already-uncalled-adjusted contributions; here we assume the
    // 30 uncalled was already returned upstream so the matched contrib is [20,20,20].
    const matched = [20n, 20n, 20n]
    const pots = buildSidePots(matched, folded)
    expect(pots).toHaveLength(1)
    expect(pots[0]!.amount).toBe(60n)
    expect(pots[0]!.eligible).toEqual([1, 2]) // seat 0 folded
    expect(sumPots(pots)).toBe(sumContrib(matched))
    // and the original contrib still conserves once the uncalled 30 is accounted separately
    expect(sumContrib(contrib)).toBe(sumPots(pots) + 30n)
  })

  it('zero-contribution seats (folded preflop, never posted) produce no spurious pot/eligibility', () => {
    const contrib = [0n, 10n, 10n]
    const folded = [true, false, false]
    const pots = buildSidePots(contrib, folded)
    expect(pots).toHaveLength(1)
    expect(pots[0]!.amount).toBe(20n)
    expect(pots[0]!.eligible).toEqual([1, 2])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('all-but-one folded: a single pot, the lone live seat eligible (uncontested)', () => {
    const contrib = [10n, 10n, 10n]
    const folded = [false, true, true]
    const pots = buildSidePots(contrib, folded)
    expect(pots).toHaveLength(1)
    expect(pots[0]!.amount).toBe(30n)
    expect(pots[0]!.eligible).toEqual([0])
    expect(sumPots(pots)).toBe(sumContrib(contrib))
  })

  it('conservation holds across randomized contributions/folds', () => {
    let a = 0x1234_5678 >>> 0
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let trial = 0; trial < 2000; trial++) {
      const n = 2 + Math.floor(rnd() * 8) // 2..9 seats
      const contrib = Array.from({ length: n }, () => BigInt(Math.floor(rnd() * 100)))
      const folded = Array.from({ length: n }, () => rnd() < 0.3)
      const pots = buildSidePots(contrib, folded)
      expect(sumPots(pots)).toBe(sumContrib(contrib))
      // every pot's eligible set excludes folded seats and is sorted ascending
      for (const p of pots) {
        for (const e of p.eligible) expect(folded[e]).toBe(false)
        const sorted = [...p.eligible].sort((x, y) => x - y)
        expect(p.eligible).toEqual(sorted)
        expect(p.amount > 0n).toBe(true)
      }
    }
  })
})

describe('splitPot — deterministic odd-chip remainder', () => {
  it('even split: equal shares, no remainder', () => {
    // amount 30 among seats {1,3}, button 0, n=4
    const r = splitPot(30n, [1, 3], 0, 4)
    expect(r).toEqual([
      { seat: 1, amount: 15n },
      { seat: 3, amount: 15n },
    ])
  })

  it('odd chip goes to the first eligible seat left of the button (lowest seat index clockwise from button+1)', () => {
    // amount 31 among seats {1,3}, button 0, n=4.
    // Order of preference starts at button+1 = seat 1, then 2, 3, ... wrapping.
    // First eligible in that order is seat 1 -> gets the odd chip.
    const r = splitPot(31n, [1, 3], 0, 4)
    expect(r).toEqual([
      { seat: 1, amount: 16n },
      { seat: 3, amount: 15n },
    ])
  })

  it('odd-chip preference wraps around the button', () => {
    // amount 31 among seats {0,3}, button 2, n=4.
    // preference order from button+1: 3, 0, 1, 2. First eligible = seat 3.
    const r = splitPot(31n, [0, 3], 2, 4)
    expect(r).toEqual([
      { seat: 3, amount: 16n },
      { seat: 0, amount: 15n },
    ])
  })

  it('two odd chips, three winners: the two earliest-in-order seats each get one', () => {
    // amount 32 among {0,1,2}, button 3 (n=4) -> base 10 each, remainder 2.
    // preference order from button+1=0: 0,1,2. seats 0 and 1 get +1.
    const r = splitPot(32n, [0, 1, 2], 3, 4)
    expect(r).toEqual([
      { seat: 0, amount: 11n },
      { seat: 1, amount: 11n },
      { seat: 2, amount: 10n },
    ])
  })

  it('single winner takes the whole pot', () => {
    expect(splitPot(37n, [2], 0, 4)).toEqual([{ seat: 2, amount: 37n }])
  })

  it('conserves: Σ shares == amount', () => {
    let a = 0x9e37_79b9 >>> 0
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let trial = 0; trial < 1000; trial++) {
      const n = 2 + Math.floor(rnd() * 8)
      const button = Math.floor(rnd() * n)
      const k = 1 + Math.floor(rnd() * n)
      const winners = [...Array(n).keys()].sort(() => rnd() - 0.5).slice(0, k).sort((x, y) => x - y)
      const amount = BigInt(Math.floor(rnd() * 1000))
      const shares = splitPot(amount, winners, button, n)
      const total = shares.reduce((acc, s) => acc + s.amount, 0n)
      expect(total).toBe(amount)
    }
  })
})
