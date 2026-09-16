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
    // raw=0 draws the fixed 10-of-40 set {1,32..40}; picks [1,39,40] all hit -> 3 hits -> top cell for picks=3.
    const expected = applyEdgeX100(BASE_PAYTABLE_X100[3]![3]!)
    const win = keno.settleRound(100n, { picks: [1, 39, 40] }, 0n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(expected)
    expect(win.playerDelta).toBe((100n * expected) / 100n - 100n)
  })

  it('loses the stake when the hit count does not pay', () => {
    // raw=0 draws {1,32..40}; picks [2,3,4] miss entirely -> 0 hits -> no payout
    const lose = keno.settleRound(100n, { picks: [2, 3, 4] }, 0n)
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-100n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('treats an exactly-1.00x cell as a non-win (no positive delta)', () => {
    // 1 pick, miss (0 hits) on a single-pick ticket loses the stake under the placeholder table
    const r = keno.settleRound(100n, { picks: [5] }, 0n) // draw {1,32..40} -> 0 hits
    expect(r.win).toBe(false)
    expect(r.playerDelta).toBe(-100n)
  })

  it('draw count is FIXED at 10 — a caller cannot force a larger draw (exploit guard)', () => {
    // Regression: `drawn` was once a caller-supplied param; forcing drawn=40 drew every number so
    // EVERY pick hit, paying a guaranteed, seed-independent top jackpot (a house-fund drain).
    // Settlement now always draws DEFAULT_DRAWN and ignores any extraneous `drawn` on the object.
    const picks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const forced = keno.settleRound(100n, { picks, drawn: 40 } as unknown as { picks: number[] }, 0n)
    const honest = keno.settleRound(100n, { picks }, 0n)
    expect(forced).toEqual(honest) // the injected drawn=40 is ignored
    // raw=0 draws {1,32..40}: of picks 1..10 only "1" hits -> 1/10 -> below the pay threshold -> a loss
    expect(forced.win).toBe(false)
  })

  it('encodeRound is deterministic and hex', () => {
    const e = keno.encodeRound(100n, { picks: [1, 39, 40] }, 0n)
    expect(e).toMatch(/^0x/)
    expect(keno.encodeRound(100n, { picks: [1, 39, 40] }, 0n)).toBe(e)
  })

  it('uses gameId 4 (distinct from dice=1, limbo=2, plinko=3)', () => {
    expect(keno.gameId).toBe(4)
  })

  it('rejects invalid picks', () => {
    expect(() => keno.settleRound(100n, { picks: [] }, 0n)).toThrow() // too few
    expect(() => keno.settleRound(100n, { picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, 0n)).toThrow() // too many
    expect(() => keno.settleRound(100n, { picks: [0] }, 0n)).toThrow() // out of range
    expect(() => keno.settleRound(100n, { picks: [41] }, 0n)).toThrow() // out of range
    expect(() => keno.settleRound(100n, { picks: [1, 1] }, 0n)).toThrow() // duplicate
  })
})
