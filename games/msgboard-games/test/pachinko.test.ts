import { describe, it, expect } from 'vitest'
import {
  pachinko, pachinkoFairTableX100, pachinkoMultiplierX100, type PachinkoRisk,
} from '../src/games/pachinko'
import { plinkoBucket, plinkoEdgedX100 } from '../src/games/plinko'

const STAKE = 1_000_000n

describe('pachinko (plinko-engine reskin)', () => {
  it('uses the plinko binomial bucket and edge verbatim', () => {
    // a raw whose low `rows` bits have exactly k ones lands in slot k
    for (let k = 0; k <= 12; k++) {
      const raw = (1n << BigInt(k)) - 1n
      expect(plinkoBucket(raw, 12)).toBe(k)
      const fair = pachinkoFairTableX100('medium', 12)[k]!
      expect(pachinko.settleRound(STAKE, { risk: 'medium', rows: 12 }, raw).multiplierX100)
        .toBe(plinkoEdgedX100(fair))
    }
  })

  it('escrow ceiling bounds every slot and is reachable, for every shipped risk', () => {
    for (const risk of ['low', 'medium', 'high'] as PachinkoRisk[]) {
      const rows = 12
      const max = pachinko.maxMultiplierX100({ risk, rows })
      const seen: bigint[] = []
      for (let slot = 0; slot <= rows; slot++) {
        const raw = (1n << BigInt(slot)) - 1n
        const m = pachinko.settleRound(STAKE, { risk, rows }, raw).multiplierX100
        expect(m).toBeLessThanOrEqual(max)
        expect(m).toBe(pachinkoMultiplierX100(risk, rows, slot))
        seen.push(m)
      }
      expect(seen.some((m) => m === max)).toBe(true)
    }
  })

  it('rejects unsupported rows', () => {
    expect(() => pachinko.settleRound(STAKE, { risk: 'low', rows: 8 }, 0n)).toThrow()
    expect(() => pachinko.settleRound(STAKE, { risk: 'low', rows: 99 }, 0n)).toThrow()
  })
})
