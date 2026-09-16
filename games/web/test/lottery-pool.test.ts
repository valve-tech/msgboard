import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { commitSeed } from '@msgboard/games'
import {
  lotteryPoolDraw, lotteryPoolSettle, lotteryPoolTotal, participationCommitByStake, ownerAtPoint,
  verifyLotteryPoolDraw, type LotteryEntry,
} from '../src/model/lottery-pool'

const addr = (n: number): viem.Hex => `0x${n.toString(16).padStart(40, '0')}`
const seed = (s: string): viem.Hex => viem.keccak256(viem.toHex(s))

// Continuous stakes — none sit on a fixed ticket-price ladder.
const ENTRIES: LotteryEntry[] = [
  { buyer: addr(1), stake: viem.parseEther('0.3') },
  { buyer: addr(2), stake: viem.parseEther('0.1') },
  { buyer: addr(3), stake: viem.parseEther('0.5') },
  { buyer: addr(4), stake: viem.parseEther('0.1') },
] // 1.0 ETH pool total

describe('lottery pool — continuous-stake pari-mutuel draw', () => {
  it('totals stake and maps every point to the right owner (cumulative ranges)', () => {
    expect(lotteryPoolTotal(ENTRIES)).toBe(viem.parseEther('1.0'))
    // [0, 0.3) -> buyer1; [0.3, 0.4) -> buyer2; [0.4, 0.9) -> buyer3; [0.9, 1.0) -> buyer4
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0'))).toBe(addr(1))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.299'))).toBe(addr(1))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.3'))).toBe(addr(2))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.35'))).toBe(addr(2))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.4'))).toBe(addr(3))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.89'))).toBe(addr(3))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.9'))).toBe(addr(4))
    expect(ownerAtPoint(ENTRIES, viem.parseEther('0.999999999999999999'))).toBe(addr(4))
    expect(() => ownerAtPoint(ENTRIES, viem.parseEther('1.0'))).toThrow() // == total, out of range
  })

  it('draw is deterministic and the winner owns the drawn point', () => {
    const a = lotteryPoolDraw(seed('server'), ENTRIES, 1n)
    const b = lotteryPoolDraw(seed('server'), ENTRIES, 1n)
    expect(a).toEqual(b)
    expect(a.winningPoint).toBeGreaterThanOrEqual(0n)
    expect(a.winningPoint).toBeLessThan(viem.parseEther('1.0'))
    expect(a.winner).toBe(ownerAtPoint(ENTRIES, a.winningPoint))
  })

  it('any arbitrary stake amount participates correctly — no forced step/denomination', () => {
    const oddEntries: LotteryEntry[] = [
      { buyer: addr(9), stake: 1n }, // 1 wei — the finest possible continuous amount
      { buyer: addr(10), stake: viem.parseEther('2.718281828459045235') },
    ]
    expect(lotteryPoolTotal(oddEntries)).toBe(1n + viem.parseEther('2.718281828459045235'))
    const draw = lotteryPoolDraw(seed('odd'), oddEntries, 5n)
    expect(draw.winner).toBe(ownerAtPoint(oddEntries, draw.winningPoint))
  })

  it('the draw is bound to the entry list — any change to participation changes the entropy', () => {
    const pc1 = participationCommitByStake(ENTRIES)
    const moreEntries: LotteryEntry[] = [...ENTRIES, { buyer: addr(5), stake: viem.parseEther('0.2') }]
    expect(participationCommitByStake(moreEntries)).not.toBe(pc1)
    const reordered: LotteryEntry[] = [ENTRIES[1]!, ENTRIES[0]!, ENTRIES[2]!, ENTRIES[3]!]
    expect(participationCommitByStake(reordered)).not.toBe(pc1) // order is part of the canonical mapping
  })

  it('win frequency tracks stake share (fairness over many nonces)', () => {
    const counts = new Map<viem.Hex, number>()
    const N = 20_000
    for (let i = 0; i < N; i++) {
      const w = lotteryPoolDraw(seed('chain'), ENTRIES, BigInt(i)).winner
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
    // buyer3 holds 0.5/1.0 of the pool -> ~50% of wins; buyer2 holds 0.1/1.0 -> ~10%
    expect((counts.get(addr(3)) ?? 0) / N).toBeGreaterThan(0.45)
    expect((counts.get(addr(3)) ?? 0) / N).toBeLessThan(0.55)
    expect((counts.get(addr(2)) ?? 0) / N).toBeGreaterThan(0.06)
    expect((counts.get(addr(2)) ?? 0) / N).toBeLessThan(0.14)
  })

  it('pool economics: rake + prize == pool, exactly', () => {
    const s = lotteryPoolSettle(ENTRIES, 500n) // 5% rake
    expect(s.pool).toBe(viem.parseEther('1.0'))
    expect(s.rake).toBe((s.pool * 500n) / 10_000n)
    expect(s.rake + s.prize).toBe(s.pool) // no wei created or destroyed
  })

  it('rejects a non-positive stake and an empty pool', () => {
    expect(() => lotteryPoolTotal([{ buyer: addr(1), stake: 0n }])).toThrow()
    expect(() => lotteryPoolTotal([{ buyer: addr(1), stake: -1n }])).toThrow()
    expect(() => lotteryPoolTotal([])).toThrow()
  })

  describe('provably-fair / ungrindable', () => {
    it('verify accepts the true draw and rejects a wrong seed or forged winner', () => {
      const server = seed('server')
      const commit = commitSeed(server)
      const draw = lotteryPoolDraw(server, ENTRIES, 1n)
      expect(verifyLotteryPoolDraw(commit, server, ENTRIES, 1n, draw).ok).toBe(true)
      expect(verifyLotteryPoolDraw(commit, seed('other'), ENTRIES, 1n, draw).ok).toBe(false)
      const forged = { winningPoint: draw.winningPoint, winner: addr(99) }
      expect(verifyLotteryPoolDraw(commit, server, ENTRIES, 1n, forged).ok).toBe(false)
    })
  })
})
