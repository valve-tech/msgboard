import { describe, it, expect } from 'vitest'
import { limbo, limboResultX100, limboWinChanceX100 } from '../src/games/limbo'

describe('limbo (target multiplier)', () => {
  it('reproduces the morbius reference: target 5x -> 19.80% win chance', () => {
    // target 5x == 500 (hundredths). winChance = (10000-100)/5 = 1980 -> 19.80%
    expect(limboWinChanceX100(500n)).toBe(1980n)
  })

  it('result is 99_000_000 / (1_000_000 - u), in hundredths', () => {
    expect(limboResultX100(0n)).toBe(99n) // u=0 -> 0.99x
    expect(limboResultX100(999_999n)).toBe(99_000_000n) // u max -> huge
  })

  it('wins when result >= target and pays stake*(target-1); loses stake otherwise', () => {
    // choose raw so u = raw % 1_000_000. Need result >= 500 (5.00x): 99_000_000/(1e6-u) >= 500
    // => 1e6-u <= 198000 => u >= 802000. pick u = 900000 -> result 99_000_000/100000 = 990 (9.90x) >= 500 win
    const win = limbo.settleRound(10n, { targetX100: 500n }, 900_000n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(500n)         // pays the target multiplier
    expect(win.playerDelta).toBe(40n)             // 10*500/100 - 10 = 40

    const lose = limbo.settleRound(10n, { targetX100: 500n }, 100_000n) // result small -> lose
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-10n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('rejects a target below 1.00x', () => {
    expect(() => limbo.settleRound(10n, { targetX100: 99n }, 1n)).toThrow()
  })

  it('rejects a target above the max (990000.00x)', () => {
    expect(() => limbo.settleRound(10n, { targetX100: 99_000_001n }, 1n)).toThrow()
  })
})
