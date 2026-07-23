import { describe, it, expect } from 'vitest'
import {
  dicex2, diceX2Rolls, diceX2WinCountScaled, diceX2MultiplierX100,
} from '../src/games/dicex2'
import { subRandom } from '../src/rng'

const STAKE = 1_000_000n

describe('dicex2 (two-roll dice)', () => {
  it('derives two independent rolls via subRandom(raw, 0|1)', () => {
    const raw = 123456789n
    expect(diceX2Rolls(raw)).toEqual([subRandom(raw, 0n) % 10_000n, subRandom(raw, 1n) % 10_000n])
  })

  it('win-count and multiplier match the combined win chance, edged once', () => {
    // target 5000 (50.00%): both -> p^2 = 0.25 -> 3.96x ; either -> 0.75 -> 1.32x
    expect(diceX2WinCountScaled(5000n, 'both')).toBe(25_000_000n)
    expect(diceX2WinCountScaled(5000n, 'either')).toBe(75_000_000n)
    expect(diceX2MultiplierX100(5000n, 'both')).toBe(396n)
    expect(diceX2MultiplierX100(5000n, 'either')).toBe(132n)
    // 'both' always pays more than 'either' for the same target
    for (const t of [100n, 2500n, 5000n, 9000n, 9899n]) {
      expect(diceX2MultiplierX100(t, 'both')).toBeGreaterThan(diceX2MultiplierX100(t, 'either'))
    }
  })

  it('both-mode wins only when both rolls are under target', () => {
    // search a few raws and check settle against the explicit two-roll rule
    for (let raw = 1n; raw < 200n; raw++) {
      const [a, b] = diceX2Rolls(raw)
      const expectBoth = a < 5000n && b < 5000n
      const r = dicex2.settleRound(STAKE, { targetX100: 5000n, mode: 'both' }, raw)
      expect(r.win).toBe(expectBoth)
      if (expectBoth) expect(r.multiplierX100).toBe(396n)
      else expect(r.multiplierX100).toBe(0n)
    }
  })

  it('either-mode wins when at least one roll is under target', () => {
    for (let raw = 1n; raw < 200n; raw++) {
      const [a, b] = diceX2Rolls(raw)
      const expectEither = a < 5000n || b < 5000n
      const r = dicex2.settleRound(STAKE, { targetX100: 5000n, mode: 'either' }, raw)
      expect(r.win).toBe(expectEither)
    }
  })

  it('escrow ceiling equals the win multiplier and bounds every outcome', () => {
    for (const mode of ['both', 'either'] as const) {
      for (const targetX100 of [100n, 2500n, 5000n, 9899n]) {
        const max = dicex2.maxMultiplierX100({ targetX100, mode })
        expect(max).toBe(diceX2MultiplierX100(targetX100, mode))
        for (let raw = 1n; raw < 300n; raw++) {
          expect(dicex2.settleRound(STAKE, { targetX100, mode }, raw).multiplierX100).toBeLessThanOrEqual(max)
        }
      }
    }
  })

  it('rejects out-of-range target or bad mode', () => {
    expect(() => dicex2.settleRound(STAKE, { targetX100: 99n, mode: 'both' }, 1n)).toThrow()
    expect(() => dicex2.settleRound(STAKE, { targetX100: 9900n, mode: 'both' }, 1n)).toThrow()
    // @ts-expect-error bad mode
    expect(() => dicex2.settleRound(STAKE, { targetX100: 5000n, mode: 'triple' }, 1n)).toThrow()
  })
})
