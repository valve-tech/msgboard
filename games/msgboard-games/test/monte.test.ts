import { describe, it, expect } from 'vitest'
import { monte, monteWinningSlot, monteMultiplierX100, SLOTS } from '../src/games/monte'

describe('monte (three-card monte)', () => {
  it('winning slot is raw % 3 and payout is 3x edged (2.97x)', () => {
    expect(monteWinningSlot(0n)).toBe(0)
    expect(monteWinningSlot(7n)).toBe(1)
    expect(monteWinningSlot(8n)).toBe(2)
    expect(monteMultiplierX100()).toBe(297n) // 3*100*9900/10000
  })

  it('pays when the pick matches the seed-derived winning slot, loses otherwise', () => {
    // raw % 3 == 0 -> winning slot 0
    const win = monte.settleRound(100n, { pick: 0 }, 9n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(297n)
    expect(win.playerDelta).toBe(197n) // 100*297/100 - 100

    const lose = monte.settleRound(100n, { pick: 1 }, 9n) // winning is 0, picked 1
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-100n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('every slot is reachable and the ceiling bounds every outcome', () => {
    const max = monte.maxMultiplierX100({ pick: 0 })
    const seen = new Set<number>()
    for (let raw = 0n; raw < 30n; raw++) {
      seen.add(monteWinningSlot(raw))
      for (let pick = 0; pick < SLOTS; pick++) {
        expect(monte.settleRound(100n, { pick }, raw).multiplierX100).toBeLessThanOrEqual(max)
      }
    }
    expect(seen).toEqual(new Set([0, 1, 2]))
  })

  it('rejects an out-of-range pick', () => {
    expect(() => monte.settleRound(100n, { pick: 3 }, 1n)).toThrow()
    expect(() => monte.settleRound(100n, { pick: -1 }, 1n)).toThrow()
  })
})
