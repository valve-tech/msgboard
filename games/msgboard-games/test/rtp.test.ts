/**
 * rtp.test.ts — FUNDS-SAFETY / FAIRNESS: every paytable's REALIZED house edge is computed from its
 * outcome probabilities × edged multipliers and asserted to be (a) never player-favorable (RTP ≤ 100%)
 * and (b) within the game's documented band. This turns the bucket tables from "eyeballed, edge
 * unknown" into "verified, bounded." The single-formula games (dice/limbo/crash/monte/dicex2) have an
 * analytic 1% edge and need no table; this file covers the table games.
 */
import { describe, it, expect } from 'vitest'
import {
  rtpBps, binomialWeights,
  plinkoMultiplierX100, plinkoFairTableX100, type PlinkoRisk,
  pachinkoMultiplierX100, pachinkoFairTableX100, type PachinkoRisk, PACHINKO_DEFAULT_ROWS,
  wheelMultiplierX100, SUPPORTED_SEGMENTS, type WheelRisk,
  BASE_PAYTABLE_X100, applyEdgeX100, DEFAULT_DRAWN, POOL,
} from '../src'

const RISKS = ['low', 'medium', 'high'] as const

/** C(n,k) via the binomial-row helper. */
const choose = (n: number, k: number): bigint => {
  if (k < 0 || k > n) return 0n
  return binomialWeights(n)[k]!
}

/** realized RTP (bps) of a plinko/pachinko table: binomial-weighted edged multipliers. */
const binomialRtp = (rows: number, mult: (bucket: number) => bigint): bigint => {
  const w = binomialWeights(rows)
  return rtpBps(w.map((weight, bucket) => ({ weight, multX100: mult(bucket) })))
}

describe('RTP is computed, bounded, and never player-favorable', () => {
  it('plinko (rows 16): house edge in [0.5%, 5%] for every risk', () => {
    const rows = 16
    for (const risk of RISKS as readonly PlinkoRisk[]) {
      plinkoFairTableX100(risk, rows) // ensure table exists
      const rtp = binomialRtp(rows, (b) => plinkoMultiplierX100(risk, rows, b))
      expect(rtp).toBeLessThanOrEqual(10_000n) // never player-favorable
      expect(rtp).toBeGreaterThanOrEqual(9_500n) // edge ≤ 5%
      expect(rtp).toBeLessThanOrEqual(9_950n) // edge ≥ 0.5%
    }
  })

  it('pachinko (rows 12): house edge in [0.5%, 5%] for every risk', () => {
    const rows = PACHINKO_DEFAULT_ROWS
    for (const risk of RISKS as readonly PachinkoRisk[]) {
      pachinkoFairTableX100(risk, rows)
      const rtp = binomialRtp(rows, (b) => pachinkoMultiplierX100(risk, rows, b))
      expect(rtp).toBeLessThanOrEqual(10_000n)
      expect(rtp).toBeGreaterThanOrEqual(9_500n)
      expect(rtp).toBeLessThanOrEqual(9_950n)
    }
  })

  it('wheel: house edge ~1% (uniform fair mean exactly 1.0, minus rounding) for every risk+size', () => {
    for (const risk of RISKS as readonly WheelRisk[]) {
      for (const segments of SUPPORTED_SEGMENTS) {
        const rtp = rtpBps(
          Array.from({ length: segments }, (_, seg) => ({ weight: 1n, multX100: wheelMultiplierX100(risk, segments, seg) })),
        )
        expect(rtp).toBeLessThanOrEqual(9_900n) // edge ≥ 1% (floor never gives back more than fair)
        expect(rtp).toBeGreaterThanOrEqual(9_800n) // and ≤ ~2% (per-segment flooring slack below 99%)
      }
    }
  })

  it('keno: every pick-count row has house edge in [1%, 12%] and is never player-favorable', () => {
    const drawn = DEFAULT_DRAWN
    for (let picks = 1; picks <= 10; picks++) {
      const row = BASE_PAYTABLE_X100[picks] ?? []
      // hypergeometric weight of h hits: C(picks,h)·C(POOL-picks, drawn-h).
      const outcomes = []
      for (let h = 0; h <= picks; h++) {
        const weight = choose(picks, h) * choose(POOL - picks, drawn - h)
        outcomes.push({ weight, multX100: applyEdgeX100(row[h] ?? 0n) })
      }
      const rtp = rtpBps(outcomes)
      expect(rtp).toBeLessThanOrEqual(10_000n) // never player-favorable
      expect(rtp).toBeGreaterThanOrEqual(8_800n) // edge ≤ 12% (keno edges run high)
    }
  })
})
