import { describe, it, expect } from 'vitest'
import { craps, crapsRoll, resolveCraps, type CrapsBet } from '../src/games/craps'

const STAKE = 1_000_000n

describe('craps (pass / dont-pass)', () => {
  it('dice are 1..6 and deterministic in raw', () => {
    for (let raw = 0n; raw < 50n; raw++) {
      const [a, b] = crapsRoll(raw, 0)
      expect(a).toBeGreaterThanOrEqual(1); expect(a).toBeLessThanOrEqual(6)
      expect(b).toBeGreaterThanOrEqual(1); expect(b).toBeLessThanOrEqual(6)
    }
    expect(crapsRoll(42n, 3)).toEqual(crapsRoll(42n, 3))
  })

  it('resolves every shoot to a terminal result with consistent first/last rolls', () => {
    for (let raw = 0n; raw < 500n; raw++) {
      const { rolls, point, result } = resolveCraps(raw, 'pass')
      expect(['win', 'lose', 'push']).toContain(result)
      const co = rolls[0]![0] + rolls[0]![1]
      if (co === 7 || co === 11) { expect(result).toBe('win'); expect(point).toBeNull() }
      else if (co === 2 || co === 3 || co === 12) { expect(result).toBe('lose'); expect(point).toBeNull() }
      else {
        expect(point).toBe(co)
        const last = rolls[rolls.length - 1]!
        const lastSum = last[0] + last[1]
        // pass resolves only on point (win) or 7 (lose)
        expect(lastSum === co || lastSum === 7).toBe(true)
        expect(result).toBe(lastSum === co ? 'win' : 'lose')
      }
    }
  })

  it('dont-pass mirrors pass except 12 is a push (bar 12)', () => {
    for (let raw = 0n; raw < 500n; raw++) {
      const pass = resolveCraps(raw, 'pass')
      const dont = resolveCraps(raw, 'dontpass')
      const co = pass.rolls[0]![0] + pass.rolls[0]![1]
      if (co === 12) {
        expect(pass.result).toBe('lose')
        expect(dont.result).toBe('push')
      } else {
        // exact opposite outcomes otherwise
        expect(dont.result).toBe(pass.result === 'win' ? 'lose' : 'win')
      }
    }
  })

  it('pays 1:1 on a win, loses the stake, pushes return the stake', () => {
    for (const bet of ['pass', 'dontpass'] as CrapsBet[]) {
      expect(craps.maxMultiplierX100({ bet })).toBe(200n)
      for (let raw = 0n; raw < 300n; raw++) {
        const { result } = resolveCraps(raw, bet)
        const r = craps.settleRound(STAKE, { bet }, raw)
        if (result === 'win') { expect(r.win).toBe(true); expect(r.playerDelta).toBe(STAKE) }
        else if (result === 'lose') { expect(r.playerDelta).toBe(-STAKE) }
        else { expect(r.playerDelta).toBe(0n); expect(r.multiplierX100).toBe(100n) }
      }
    }
  })

  it('finds at least one of each come-out branch across seeds (sanity)', () => {
    const seen = new Set<string>()
    for (let raw = 0n; raw < 2000n; raw++) {
      const co = crapsRoll(raw, 0)[0] + crapsRoll(raw, 0)[1]
      seen.add(co === 7 || co === 11 ? 'natural' : co === 2 || co === 3 || co === 12 ? 'craps' : 'point')
    }
    expect(seen).toEqual(new Set(['natural', 'craps', 'point']))
  })
})
