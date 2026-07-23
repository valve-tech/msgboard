import { describe, it, expect } from 'vitest'
import { dice, diceRoll, diceMultiplierX100 } from '../src/games/dice'

describe('dice (roll-under)', () => {
  it('reproduces the morbius reference: target 54.50% -> 1.81x', () => {
    // target is in hundredths of a percent: 54.50% == 5450
    expect(diceMultiplierX100(5450n)).toBe(181n) // floor(99_000_000 / 5450) = 18165 -> /100 = 181
  })

  it('roll is in [0, 9999] (hundredths of a percent)', () => {
    expect(diceRoll(0n)).toBe(0n)
    expect(diceRoll(10000n)).toBe(0n)
    expect(diceRoll(9999n)).toBe(9999n)
  })

  it('wins when roll < target and pays stake*(mult-1); loses stake otherwise', () => {
    // pick raw so roll = raw % 10000. target 5000 (50.00%).
    const win = dice.settleRound(100n, { targetX100: 5000n }, 1234n) // roll 1234 < 5000 -> win
    expect(win.win).toBe(true)
    // mult = floor(99_000_000/5000)=19800 -> x100 198 -> payout profit = 100*198/100 - 100 = 98
    expect(win.multiplierX100).toBe(198n)
    expect(win.playerDelta).toBe(98n)

    const lose = dice.settleRound(100n, { targetX100: 5000n }, 7000n) // roll 7000 >= 5000 -> lose
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-100n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('encodeRound is deterministic and hex', () => {
    const e = dice.encodeRound(100n, { targetX100: 5000n }, 1234n)
    expect(e).toMatch(/^0x/)
    expect(dice.encodeRound(100n, { targetX100: 5000n }, 1234n)).toBe(e)
  })

  it('rejects an out-of-range target', () => {
    expect(() => dice.settleRound(100n, { targetX100: 0n }, 1n)).toThrow()
    expect(() => dice.settleRound(100n, { targetX100: 9999n }, 1n)).toThrow()
  })
})
