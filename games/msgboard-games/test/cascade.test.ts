import { describe, it, expect } from 'vitest'
import { keccak256, encodeAbiParameters, hexToBigInt } from 'viem'
import {
  cascade, resolveCascade, cascadeSymbol, cascadePayX100, clusterFactor,
  COLS, ROWS, CELLS, SYMBOLS, MIN_MATCH, MAX_MULT_X100,
} from '../src'

const STAKE = 1_000_000n
const rawAt = (i: number): bigint => hexToBigInt(keccak256(encodeAbiParameters([{ type: 'uint64' }], [BigInt(i)])))

describe('cascade — tumbling-grid slot', () => {
  it('is a pure deterministic function of raw (recomputable on/off chain)', () => {
    for (let i = 0; i < 50; i++) {
      const raw = rawAt(i)
      const a = resolveCascade(raw)
      const b = resolveCascade(raw)
      expect(a.totalX100).toBe(b.totalX100)
      expect(a.finalGrid).toEqual(b.finalGrid)
      expect(a.steps.length).toBe(b.steps.length)
    }
  })

  it('settleRound multiplier == resolveCascade total, and playerDelta follows from it', () => {
    for (let i = 0; i < 200; i++) {
      const raw = rawAt(i)
      const { totalX100 } = resolveCascade(raw)
      const out = cascade.settleRound(STAKE, {}, raw)
      expect(out.multiplierX100).toBe(totalX100)
      expect(out.playerDelta).toBe((STAKE * totalX100) / 100n - STAKE)
      expect(out.win).toBe(totalX100 >= 100n)
    }
  })

  it('every payout is bounded by the escrow ceiling (funds-safety)', () => {
    const max = cascade.maxMultiplierX100({})
    expect(max).toBe(MAX_MULT_X100)
    for (let i = 0; i < 5_000; i++) {
      expect(cascade.settleRound(STAKE, {}, rawAt(i)).multiplierX100).toBeLessThanOrEqual(max)
    }
  })

  it('initial grid is exactly CELLS symbols, each in [0,SYMBOLS)', () => {
    const raw = rawAt(7)
    const grid = Array.from({ length: CELLS }, (_, i) => cascadeSymbol(raw, i))
    expect(grid.length).toBe(CELLS)
    expect(COLS * ROWS).toBe(CELLS)
    for (const s of grid) expect(s).toBeGreaterThanOrEqual(0), expect(s).toBeLessThan(SYMBOLS)
  })

  it('scatter rule: every winner has count>=MIN_MATCH; removals exactly match winner symbols', () => {
    for (let i = 0; i < 3_000; i++) {
      for (const step of resolveCascade(rawAt(i)).steps) {
        const counts = new Array<number>(SYMBOLS).fill(0)
        for (const s of step.grid) counts[s]!++
        for (const w of step.winners) expect(counts[w]!).toBeGreaterThanOrEqual(MIN_MATCH)
        const winSet = new Set(step.winners)
        step.grid.forEach((s, cell) => expect(step.removed[cell]).toBe(winSet.has(s)))
        // the step's pay is the sum of its winners' cluster pays
        const expectPay = step.winners.reduce((a, w) => a + cascadePayX100(w, counts[w]!), 0n)
        expect(step.payX100).toBe(expectPay)
      }
    }
  })

  it('cluster factor steps up at 10 and 12; below MIN_MATCH pays nothing', () => {
    expect(clusterFactor(8)).toBe(1n)
    expect(clusterFactor(9)).toBe(1n)
    expect(clusterFactor(10)).toBe(3n)
    expect(clusterFactor(11)).toBe(3n)
    expect(clusterFactor(12)).toBe(12n)
    expect(cascadePayX100(0, MIN_MATCH - 1)).toBe(0n)
    expect(cascadePayX100(7, 12)).toBeGreaterThan(cascadePayX100(0, 12)) // premium pays more
  })

  it('encodeRound is deterministic and binds (gameId, stake, raw)', () => {
    const raw = rawAt(3)
    expect(cascade.encodeRound(STAKE, {}, raw)).toBe(cascade.encodeRound(STAKE, {}, raw))
    expect(cascade.encodeRound(STAKE, {}, raw)).not.toBe(cascade.encodeRound(STAKE + 1n, {}, raw))
  })

  // RTP is verified by simulation (a tumbling slot's edge is not closed-form). The seed set is
  // deterministic (keccak of the index), so this RTP is reproducible — not a flaky statistical check —
  // and the band documents the invariant: a real house edge, never player-favorable (RTP < 100%).
  it('simulated RTP sits in a safe band strictly below 100%', () => {
    const N = 20_000
    let total = 0n
    for (let i = 0; i < N; i++) total += resolveCascade(rawAt(i)).totalX100
    const rtp = Number(total) / 100 / N
    expect(rtp).toBeGreaterThan(0.85)
    expect(rtp).toBeLessThan(0.99)
  })
})
