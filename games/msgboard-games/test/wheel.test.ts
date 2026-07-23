import { describe, it, expect } from 'vitest'
import {
  wheel, wheelFairTableX100, wheelEdgedX100, wheelSegment, wheelMultiplierX100,
  SUPPORTED_SEGMENTS, type WheelRisk,
} from '../src/games/wheel'

const STAKE = 1_000_000n

describe('wheel (segmented spin)', () => {
  it('pointer lands on raw % segments and reads the edged segment multiplier', () => {
    expect(wheelSegment(0n, 10)).toBe(0)
    expect(wheelSegment(13n, 10)).toBe(3)
    // high/10 is a single jackpot segment (the last) carrying the whole wheel; the rest pay 0.
    const fair = wheelFairTableX100('high', 10)
    expect(wheelMultiplierX100('high', 10, 9)).toBe(wheelEdgedX100(fair[9]!))
    expect(wheelMultiplierX100('high', 10, 9)).toBeGreaterThan(100n)
    expect(wheelMultiplierX100('high', 10, 0)).toBe(0n)
  })

  it('every shipped (risk, segments) table has the right length and an edged top', () => {
    for (const risk of ['low', 'medium', 'high'] as WheelRisk[]) {
      for (const segments of SUPPORTED_SEGMENTS) {
        const table = wheelFairTableX100(risk, segments)
        expect(table.length).toBe(segments)
        const max = wheel.maxMultiplierX100({ risk, segments })
        const topFair = table.reduce((a, b) => (b > a ? b : a), 0n)
        expect(max).toBe(wheelEdgedX100(topFair))
      }
    }
  })

  it('escrow ceiling bounds every segment and is reachable, for every shipped table', () => {
    for (const risk of ['low', 'medium', 'high'] as WheelRisk[]) {
      for (const segments of SUPPORTED_SEGMENTS) {
        const max = wheel.maxMultiplierX100({ risk, segments })
        const seen: bigint[] = []
        for (let seg = 0; seg < segments; seg++) {
          const m = wheel.settleRound(STAKE, { risk, segments }, BigInt(seg)).multiplierX100
          expect(m).toBeLessThanOrEqual(max)
          expect(m).toBe(wheelMultiplierX100(risk, segments, seg))
          seen.push(m)
        }
        expect(seen.some((m) => m === max)).toBe(true) // ceiling actually reachable
      }
    }
  })

  it('rejects an unsupported (risk, segments) pair', () => {
    expect(() => wheel.settleRound(STAKE, { risk: 'low', segments: 7 }, 0n)).toThrow()
  })
})
