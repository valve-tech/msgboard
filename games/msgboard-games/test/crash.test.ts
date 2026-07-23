import { describe, it, expect } from 'vitest'
import { crash, crashPointX100 } from '../src/games/crash'
import { limboResultX100 } from '../src/games/limbo'

describe('crash (pre-committed auto-cashout)', () => {
  it('crash point is the same curve as limbo: (1-edge)/(1-U) in hundredths', () => {
    expect(crashPointX100(0n)).toBe(99n) // u=0 -> 0.99x (instant crash below 1x)
    expect(crashPointX100(999_999n)).toBe(99_000_000n) // u max -> huge
    // identical to limbo for any raw < U_SPACE
    for (const u of [0n, 1n, 123n, 802_000n, 900_000n, 999_999n]) {
      expect(crashPointX100(u)).toBe(limboResultX100(u))
    }
  })

  it('wins when crash point reaches the auto-cashout and pays that multiplier', () => {
    // u=900000 -> crash point 99_000_000/100000 = 990 (9.90x). Auto-cashout 5.00x (500) is reached.
    const win = crash.settleRound(10n, { autoCashoutX100: 500n }, 900_000n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(500n)
    expect(win.playerDelta).toBe(40n) // 10*500/100 - 10

    // u=100000 -> crash point 99_000_000/900000 = 110 (1.10x) < 5.00x target -> bust
    const lose = crash.settleRound(10n, { autoCashoutX100: 500n }, 100_000n)
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-10n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('pays exactly when crash point equals the target (boundary win)', () => {
    // pick u so the crash point is an exact value, then set autoCashout equal to it.
    const u = 900_000n
    const c = crashPointX100(u) // 990
    const r = crash.settleRound(10n, { autoCashoutX100: c }, u)
    expect(r.win).toBe(true)
    expect(r.multiplierX100).toBe(c)
  })

  it('rejects an auto-cashout below 1.00x or above the max', () => {
    expect(() => crash.settleRound(10n, { autoCashoutX100: 99n }, 1n)).toThrow()
    expect(() => crash.settleRound(10n, { autoCashoutX100: 99_000_001n }, 1n)).toThrow()
  })

  it('escrow ceiling equals the auto-cashout and is the exact payout multiplier', () => {
    for (const autoCashoutX100 of [100n, 200n, 500n, 1980n, 99_000_000n]) {
      expect(crash.maxMultiplierX100({ autoCashoutX100 })).toBe(autoCashoutX100)
    }
  })
})
