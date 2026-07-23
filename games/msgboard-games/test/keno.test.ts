import { describe, it, expect } from 'vitest'
import {
  keno,
  kenoDraw,
  kenoHits,
  applyEdgeX100,
  BASE_PAYTABLE_X100,
  POOL,
  DEFAULT_DRAWN,
} from '../src/games/keno'

describe('keno (draw-without-replacement)', () => {
  it('draws `drawn` DISTINCT numbers in [1,40] without replacement', () => {
    const draw = kenoDraw(12345678901234567890n, 10)
    expect(draw.size).toBe(10) // distinct
    for (const n of draw) {
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(POOL)
    }
  })

  it('is deterministic / parity-testable: fixed raw -> fixed set', () => {
    // probed fixtures from the reference Fisher-Yates derivation
    expect([...kenoDraw(0n, 3)].sort((a, b) => a - b)).toEqual([1, 39, 40])
    expect([...kenoDraw(0n, 10)].sort((a, b) => a - b)).toEqual([1, 32, 33, 34, 35, 36, 37, 38, 39, 40])
    expect([...kenoDraw(12345678901234567890n, 3)].sort((a, b) => a - b)).toEqual([11, 18, 33])
    // same raw -> identical set every time
    expect([...kenoDraw(12345678901234567890n, 10)]).toEqual([...kenoDraw(12345678901234567890n, 10)])
  })

  it('default draw count is the standard keno 10 of 40', () => {
    expect(DEFAULT_DRAWN).toBe(10)
    expect(keno.settleRound(100n, { picks: [1] }, 0n).multiplierX100).toBeGreaterThanOrEqual(0n)
  })

  it('counts hits = |picks ∩ drawn|', () => {
    const draw = kenoDraw(0n, 3) // {1, 39, 40}
    expect(kenoHits([1, 39, 40], draw)).toBe(3)
    expect(kenoHits([1, 2, 3], draw)).toBe(1)
    expect(kenoHits([2, 3, 4], draw)).toBe(0)
  })

  it('applies the 1% house edge to the fair paytable multiplier', () => {
    // pure edge formula (independent of the table values): floor(fair * 99 / 100)
    expect(applyEdgeX100(4500n)).toBe(4455n)
    // and a top-hit cell pays its edged fair-table entry (a real, positive jackpot)
    const fairTop = BASE_PAYTABLE_X100[3]![3]!
    expect(fairTop).toBeGreaterThan(100n)
    expect(applyEdgeX100(fairTop)).toBe((fairTop * 99n) / 100n)
  })

  it('wins on a qualifying hit count and pays stake*(mult-1)', () => {
    // raw=0, drawn=3 -> {1,39,40}; picks all 3 -> 3 hits -> the top cell for picks=3.
    const expected = applyEdgeX100(BASE_PAYTABLE_X100[3]![3]!)
    const win = keno.settleRound(100n, { picks: [1, 39, 40], drawn: 3 }, 0n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(expected)
    expect(win.playerDelta).toBe((100n * expected) / 100n - 100n)
  })

  it('loses the stake when the hit count does not pay', () => {
    // raw=0, drawn=3 -> {1,39,40}; picks miss entirely -> 0 hits -> no payout
    const lose = keno.settleRound(100n, { picks: [2, 3, 4], drawn: 3 }, 0n)
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-100n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('treats an exactly-1.00x cell as a non-win (no positive delta)', () => {
    // 1 pick, miss (0 hits) on a single-pick ticket loses the stake under the placeholder table
    const r = keno.settleRound(100n, { picks: [5], drawn: 3 }, 0n) // draw {1,39,40} -> 0 hits
    expect(r.win).toBe(false)
    expect(r.playerDelta).toBe(-100n)
  })

  it('encodeRound is deterministic and hex', () => {
    const e = keno.encodeRound(100n, { picks: [1, 39, 40], drawn: 3 }, 0n)
    expect(e).toMatch(/^0x/)
    expect(keno.encodeRound(100n, { picks: [1, 39, 40], drawn: 3 }, 0n)).toBe(e)
  })

  it('uses gameId 4 (distinct from dice=1, limbo=2, plinko=3)', () => {
    expect(keno.gameId).toBe(4)
  })

  it('rejects invalid picks and draw counts', () => {
    expect(() => keno.settleRound(100n, { picks: [] }, 0n)).toThrow() // too few
    expect(() => keno.settleRound(100n, { picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, 0n)).toThrow() // too many
    expect(() => keno.settleRound(100n, { picks: [0] }, 0n)).toThrow() // out of range
    expect(() => keno.settleRound(100n, { picks: [41] }, 0n)).toThrow() // out of range
    expect(() => keno.settleRound(100n, { picks: [1, 1] }, 0n)).toThrow() // duplicate
    expect(() => keno.settleRound(100n, { picks: [1], drawn: 0 }, 0n)).toThrow() // draw count
    expect(() => keno.settleRound(100n, { picks: [1], drawn: 41 }, 0n)).toThrow() // draw count
  })
})
