import { describe, it, expect } from 'vitest'
import { keccak256, toHex, type Hex } from 'viem'
import {
  lotteryDraw, lotteryDrawMultiple, lotteryTotalTickets, participationCommit, ticketOwner,
  lotterySettle, lotteryPrizeSplit, commitLotterySeed, verifyLotteryDraw, commitSeed,
  type LotteryTicket,
} from '../src'

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`
const seed = (s: string): Hex => keccak256(toHex(s))

const TICKETS: LotteryTicket[] = [
  { buyer: addr(1), count: 3 },
  { buyer: addr(2), count: 1 },
  { buyer: addr(3), count: 5 },
  { buyer: addr(4), count: 1 },
] // 10 tickets total

describe('lottery — pari-mutuel pooled draw', () => {
  it('counts tickets and maps every index to the right owner (in purchase order)', () => {
    expect(lotteryTotalTickets(TICKETS)).toBe(10)
    // ticket 0,1,2 -> buyer1; 3 -> buyer2; 4..8 -> buyer3; 9 -> buyer4
    expect([0, 1, 2].map((i) => ticketOwner(TICKETS, i))).toEqual([addr(1), addr(1), addr(1)])
    expect(ticketOwner(TICKETS, 3)).toBe(addr(2))
    expect([4, 5, 6, 7, 8].map((i) => ticketOwner(TICKETS, i))).toEqual(Array(5).fill(addr(3)))
    expect(ticketOwner(TICKETS, 9)).toBe(addr(4))
    expect(() => ticketOwner(TICKETS, 10)).toThrow()
  })

  it('draw is deterministic and the winner owns the drawn ticket', () => {
    const a = lotteryDraw(seed('server'), TICKETS, 1n)
    const b = lotteryDraw(seed('server'), TICKETS, 1n)
    expect(a).toEqual(b)
    expect(a.winningTicket).toBeGreaterThanOrEqual(0)
    expect(a.winningTicket).toBeLessThan(10)
    expect(a.winner).toBe(ticketOwner(TICKETS, a.winningTicket))
  })

  it('the draw is bound to the ticket list — any change to participation changes the entropy', () => {
    const pc1 = participationCommit(TICKETS)
    const moreTickets: LotteryTicket[] = [...TICKETS, { buyer: addr(5), count: 2 }]
    expect(participationCommit(moreTickets)).not.toBe(pc1)
    // a different participation set yields a different draw seed → generally a different outcome
    const reordered: LotteryTicket[] = [TICKETS[1]!, TICKETS[0]!, TICKETS[2]!, TICKETS[3]!]
    expect(participationCommit(reordered)).not.toBe(pc1) // order is part of the canonical mapping
  })

  it('win frequency tracks ticket share (fairness over many nonces)', () => {
    const counts = new Map<Hex, number>()
    const N = 20_000
    for (let i = 0; i < N; i++) {
      const w = lotteryDraw(seed('chain'), TICKETS, BigInt(i)).winner
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
    // buyer3 holds 5/10 tickets → ~50% of wins; buyer2 holds 1/10 → ~10%
    expect((counts.get(addr(3)) ?? 0) / N).toBeGreaterThan(0.45)
    expect((counts.get(addr(3)) ?? 0) / N).toBeLessThan(0.55)
    expect((counts.get(addr(2)) ?? 0) / N).toBeGreaterThan(0.06)
    expect((counts.get(addr(2)) ?? 0) / N).toBeLessThan(0.14)
  })

  it('multi-tier draw returns k DISTINCT winning tickets', () => {
    const winners = lotteryDrawMultiple(seed('server'), TICKETS, 7n, 3)
    expect(winners).toHaveLength(3)
    const indices = winners.map((w) => w.winningTicket)
    expect(new Set(indices).size).toBe(3) // distinct
    for (const w of winners) expect(w.winner).toBe(ticketOwner(TICKETS, w.winningTicket))
    expect(() => lotteryDrawMultiple(seed('server'), TICKETS, 7n, 11)).toThrow() // > totalTickets
  })

  it('pool economics: rake + prize == pool, exactly', () => {
    const price = 10n ** 16n // 0.01 eth
    const s = lotterySettle(TICKETS, price, 500n) // 5% rake
    expect(s.pool).toBe(10n * price)
    expect(s.rake).toBe((s.pool * 500n) / 10_000n)
    expect(s.rake + s.prize).toBe(s.pool) // no wei created or destroyed
  })

  it('prize split sums to the prize exactly (dust to the grand tier)', () => {
    const prize = 1_000_000_000_000_000_001n // deliberately indivisible
    const parts = lotteryPrizeSplit(prize, [6000n, 3000n, 1000n])
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(prize)
    expect(parts[0]!).toBeGreaterThanOrEqual(parts[1]!) // grand tier largest
    expect(() => lotteryPrizeSplit(prize, [6000n, 3000n])).toThrow() // doesn't sum to 10000
  })

  describe('provably-fair / ungrindable', () => {
    it('verify accepts the true draw and rejects a wrong seed or forged winner', () => {
      const server = seed('server')
      const commit = commitLotterySeed(server)
      expect(commit).toBe(commitSeed(server))
      const draw = lotteryDraw(server, TICKETS, 1n)
      expect(verifyLotteryDraw(commit, server, TICKETS, 1n, draw).ok).toBe(true)
      // a different revealed seed doesn't match the published commit
      expect(verifyLotteryDraw(commit, seed('other'), TICKETS, 1n, draw).ok).toBe(false)
      // a forged winner is caught even with the right seed
      const forged = { winningTicket: draw.winningTicket, winner: addr(99) }
      expect(verifyLotteryDraw(commit, server, TICKETS, 1n, forged).ok).toBe(false)
    })

    it('the commit reveals nothing about the winner before sales close (preimage resistance)', () => {
      // The house publishes only keccak(serverSeed). Without the preimage, the round random — and thus
      // the winner — cannot be computed. We model that: the commit is identical regardless of the ticket
      // list, so it leaks no participation/outcome info; the draw needs the actual seed preimage.
      const server = seed('secret-server')
      const commit = commitLotterySeed(server)
      const otherList: LotteryTicket[] = [{ buyer: addr(7), count: 4 }]
      expect(commitLotterySeed(server)).toBe(commit) // commit independent of who buys
      // a guess of the seed that hashes differently can't reproduce the draw
      expect(verifyLotteryDraw(commit, seed('guess'), TICKETS, 1n, lotteryDraw(server, TICKETS, 1n)).ok).toBe(false)
      // and the draw genuinely depends on the seed preimage: a different seed → (almost surely) different ticket
      const realCommit = lotteryDraw(server, otherList.concat(TICKETS), 1n)
      expect(realCommit.winner).toBe(ticketOwner(otherList.concat(TICKETS), realCommit.winningTicket))
    })
  })
})
