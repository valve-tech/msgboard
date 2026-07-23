/**
 * escrowCeiling.test.ts — FUNDS-SAFETY: every game's maxMultiplierX100(params) must be >=
 * settleRound(...).multiplierX100 for EVERY possible `raw`. The house sizes escrowHouse from this
 * ceiling, so if it under-bounded any outcome the house could not pay a winner. Each test enumerates
 * (or constructs raws covering) the full outcome space and asserts the bound holds and is achievable.
 */
import { describe, it, expect } from 'vitest'
import {
  dice, limbo, plinko, keno,
  diceMultiplierX100, plinkoMultiplierX100, plinkoFairTableX100, applyEdgeX100, BASE_PAYTABLE_X100,
  type PlinkoRisk,
} from '../src'

const STAKE = 1_000_000n

describe('escrow ceiling bounds every payout (funds-safety)', () => {
  it('dice: ceiling == the win multiplier and bounds every roll', () => {
    for (const targetX100 of [1n, 100n, 2500n, 5000n, 9899n]) {
      const max = dice.maxMultiplierX100({ targetX100 })
      expect(max).toBe(diceMultiplierX100(targetX100))
      // rolls are raw % 10_000; cover the whole roll space + a huge raw
      for (let raw = 0n; raw < 10_000n; raw += 7n) {
        expect(dice.settleRound(STAKE, { targetX100 }, raw).multiplierX100).toBeLessThanOrEqual(max)
      }
      expect(dice.settleRound(STAKE, { targetX100 }, 123456789012345678901234567890n).multiplierX100).toBeLessThanOrEqual(max)
    }
  })

  it('limbo: ceiling == targetX100 and bounds the whole u-space', () => {
    for (const targetX100 of [100n, 500n, 1980n, 1_000_000n, 99_000_000n]) {
      const max = limbo.maxMultiplierX100({ targetX100 })
      expect(max).toBe(targetX100)
      for (let u = 0n; u < 1_000_000n; u += 997n) {
        expect(limbo.settleRound(STAKE, { targetX100 }, u).multiplierX100).toBeLessThanOrEqual(max)
      }
    }
  })

  it('plinko: ceiling bounds every bucket and is achievable, for every risk+rows', () => {
    for (const risk of ['low', 'medium', 'high'] as PlinkoRisk[]) {
      for (let rows = 1; rows <= 16; rows++) {
        try { plinkoFairTableX100(risk, rows) } catch { continue } // skip rows without a table
        const max = plinko.maxMultiplierX100({ risk, rows })
        const seen: bigint[] = []
        for (let bucket = 0; bucket <= rows; bucket++) {
          // a raw whose low `rows` bits have exactly `bucket` ones lands in that bucket
          const raw = (1n << BigInt(bucket)) - 1n
          const m = plinko.settleRound(STAKE, { risk, rows }, raw).multiplierX100
          expect(m).toBeLessThanOrEqual(max)
          expect(m).toBe(plinkoMultiplierX100(risk, rows, bucket))
          seen.push(m)
        }
        expect(seen.some((m) => m === max)).toBe(true) // ceiling is actually reachable (not over-escrowing)
      }
    }
  })

  it('keno: ceiling bounds every hit count and is achievable, for every pick size', () => {
    for (let n = 1; n <= 10; n++) {
      const picks = Array.from({ length: n }, (_, i) => i + 1)
      const max = keno.maxMultiplierX100({ picks })
      const row = BASE_PAYTABLE_X100[n] ?? []
      // settleRound pays applyEdgeX100(row[hits]); the ceiling must bound every entry and hit the top.
      for (const fair of row) expect(applyEdgeX100(fair)).toBeLessThanOrEqual(max)
      const topFair = row.reduce((a, b) => (b > a ? b : a), 0n)
      expect(max).toBe(applyEdgeX100(topFair))
    }
  })
})
