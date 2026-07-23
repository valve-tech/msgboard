import { expect } from 'chai'
import hre from 'hardhat'
import * as viem from 'viem'
import { evaluate7, compareHands, categoryOf, Category } from '@msgboard/holdem'

// Deterministic PRNG so every fuzz draw is reproducible from its seed alone (mirror
// HiLoWarParity's mulberry32).
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Draw `n` DISTINCT card indices (0..51) without replacement.
function drawDistinct(rnd: () => number, n: number): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  while (out.length < n) {
    const c = Math.floor(rnd() * 52)
    if (!seen.has(c)) {
      seen.add(c)
      out.push(c)
    }
  }
  return out
}

// Minimal structural view of the deployed HoldemHandEval — only the pure read path used here.
type EvalReader = { read: { evaluate7: (args: [readonly number[]]) => Promise<bigint> } }

describe('HoldemHandEval TS<->Solidity parity', () => {
  // index = (rank-2)*4 + suit; suit: 0 clubs,1 diamonds,2 hearts,3 spades.
  const card = (rank: number, suit: number) => (rank - 2) * 4 + suit

  // Deterministic anchor hands that DELIBERATELY hit every category — including the ones a
  // uniform random 7-card draw almost never produces (a straight flush is ~0.03% of hands, a
  // royal vanishingly rarer). These run through BOTH evaluators so per-category coverage is
  // genuinely PROVEN rather than hoped-for. Each is a full 7-card set (2 hole + 5 board).
  const ANCHORS: Record<number, number[]> = {
    [Category.HIGH_CARD]: [card(14, 1), card(12, 2), card(9, 3), card(7, 0), card(5, 1), card(3, 2), card(2, 3)],
    [Category.PAIR]: [card(14, 1), card(14, 2), card(9, 3), card(7, 0), card(5, 1), card(3, 2), card(2, 3)],
    [Category.TWO_PAIR]: [card(14, 1), card(14, 2), card(9, 3), card(9, 0), card(5, 1), card(3, 2), card(2, 3)],
    [Category.TRIPS]: [card(14, 1), card(14, 2), card(14, 3), card(9, 0), card(5, 1), card(3, 2), card(2, 3)],
    [Category.STRAIGHT]: [card(10, 1), card(9, 2), card(8, 3), card(7, 0), card(6, 1), card(2, 2), card(2, 3)],
    [Category.FLUSH]: [card(14, 1), card(11, 1), card(9, 1), card(6, 1), card(3, 1), card(13, 2), card(2, 3)],
    [Category.FULL_HOUSE]: [card(14, 1), card(14, 2), card(14, 3), card(9, 0), card(9, 1), card(3, 2), card(2, 3)],
    [Category.QUADS]: [card(14, 1), card(14, 2), card(14, 3), card(14, 0), card(9, 1), card(3, 2), card(2, 3)],
    // wheel straight flush (A-2-3-4-5 same suit) AND a royal are both this category:
    [Category.STRAIGHT_FLUSH]: [card(9, 1), card(8, 1), card(7, 1), card(6, 1), card(5, 1), card(13, 2), card(2, 3)],
  }
  const ROYAL = [card(14, 3), card(13, 3), card(12, 3), card(11, 3), card(10, 3), card(2, 0), card(3, 1)]
  const WHEEL_SF = [card(14, 1), card(2, 1), card(3, 1), card(4, 1), card(5, 1), card(13, 2), card(12, 3)]

  it('HandEval parity: random 7-card scores agree, pair orderings agree in sign, every category covered', async function () {
    this.timeout(600_000)
    const evalc = (await hre.viem.deployContract('HoldemHandEval' as any, [])) as unknown as EvalReader

    const catSeen: Record<number, number> = {}
    let scoreMismatch: string | null = null

    // Cache the raw 7-card sets + both scores so the pairwise-ordering pass can reuse them.
    const sets: number[][] = []
    const solScores: bigint[] = []

    // checkHand: score a 7-card set on BOTH sides, assert score equality, record coverage.
    const checkHand = async (cards: number[]) => {
      const ts = evaluate7(cards)
      const sol = await evalc.read.evaluate7([cards as readonly number[]])
      sets.push(cards)
      solScores.push(sol)
      const cat = categoryOf(ts)
      catSeen[cat] = (catSeen[cat] ?? 0) + 1
      if (ts !== sol && !scoreMismatch) scoreMismatch = `score mismatch on [${cards}]: TS=${ts} SOL=${sol}`
    }

    // 0) Deterministic anchors first — guarantees the rare categories are exercised on both
    //    evaluators (a random draw effectively never yields a straight flush).
    for (const cards of Object.values(ANCHORS)) await checkHand(cards)
    await checkHand(ROYAL)
    await checkHand(WHEEL_SF)

    // 1) Absolute-score parity over N random 7-card hands. N is sized so the whole suite stays
    //    well under the mocha timeout (each hand is one in-process eth_call; see report for the
    //    count rationale — same "fewer runs, coverage still asserted" posture as Task 5).
    //    Instrumented runs are several-fold slower and measure LINE coverage, not statistical
    //    depth — a small sample walks the same code paths, so shrink the sweep there.
    const N = process.env.SOLIDITY_COVERAGE === 'true' ? 150 : 1200
    const rnd = mulberry32(0x5eed)
    const BATCH = 100 // batch the reads so the in-process node stays busy
    for (let base = 0; base < N && !scoreMismatch; base += BATCH) {
      const batchSets: number[][] = []
      for (let i = base; i < base + BATCH && i < N; i++) batchSets.push(drawDistinct(rnd, 7))
      const sols = await Promise.all(
        batchSets.map((cards) => evalc.read.evaluate7([cards as readonly number[]])),
      )
      for (let k = 0; k < batchSets.length; k++) {
        const cards = batchSets[k]!
        const ts = evaluate7(cards)
        const sol = sols[k]!
        sets.push(cards)
        solScores.push(sol)
        const cat = categoryOf(ts)
        catSeen[cat] = (catSeen[cat] ?? 0) + 1
        if (ts !== sol && !scoreMismatch) scoreMismatch = `score mismatch on [${cards}]: TS=${ts} SOL=${sol}`
      }
    }
    expect(scoreMismatch, scoreMismatch ?? 'score parity drift').to.equal(null)

    // 2) Pairwise-ordering parity: sign(TS compare) == sign(Solidity compare) over many pairs.
    //    Pairs are drawn from the full pool (anchors + random) so cross-category orderings —
    //    incl. the rare straight flush vs everything below it — are exercised.
    let orderMismatch: string | null = null
    const PAIRS = process.env.SOLIDITY_COVERAGE === 'true' ? 300 : 3000
    const prnd = mulberry32(0xc0ffee)
    for (let i = 0; i < PAIRS && !orderMismatch; i++) {
      const ia = Math.floor(prnd() * sets.length)
      const ib = Math.floor(prnd() * sets.length)
      const tsSign = Math.sign(compareHands(sets[ia]!, sets[ib]!))
      const sa = solScores[ia]!
      const sb = solScores[ib]!
      const solSign = sa > sb ? 1 : sa < sb ? -1 : 0
      if (tsSign !== solSign) {
        orderMismatch = `order mismatch: pair (${ia},${ib}) TS=${tsSign} SOL=${solSign}`
      }
    }
    expect(orderMismatch, orderMismatch ?? 'ordering parity drift').to.equal(null)

    // 3) Coverage: every one of the 9 categories was scored (identically) on both sides.
    for (const c of [
      Category.HIGH_CARD,
      Category.PAIR,
      Category.TWO_PAIR,
      Category.TRIPS,
      Category.STRAIGHT,
      Category.FLUSH,
      Category.FULL_HOUSE,
      Category.QUADS,
      Category.STRAIGHT_FLUSH,
    ]) {
      expect(catSeen[c] ?? 0, `category ${Category[c]} never appeared`).to.be.greaterThan(0)
    }
  })

  it('known reference hands (royal + wheel straight flush) score-match on-chain', async () => {
    const evalc = (await hre.viem.deployContract('HoldemHandEval' as any, [])) as unknown as EvalReader
    const wheel = [card(14, 1), card(2, 2), card(3, 3), card(4, 0), card(5, 1), card(13, 2), card(12, 3)]
    for (const cards of [ROYAL, WHEEL_SF, wheel]) {
      const ts = evaluate7(cards)
      const sol = await evalc.read.evaluate7([cards as readonly number[]])
      expect(sol).to.equal(ts)
    }
  })
})
