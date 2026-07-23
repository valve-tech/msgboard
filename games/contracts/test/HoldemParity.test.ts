import { expect } from 'chai'
import hre from 'hardhat'
import * as viem from 'viem'
import {
  Phase,
  initHoldem,
  applyMove,
  encodeGameState,
  encodeMove,
  hashGameState,
  whoseTurn,
  type HoldemState,
  type Move,
} from '@msgboard/holdem'

// Deterministic PRNG so every walk is reproducible from its seed alone.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

// Deal `count` DISTINCT card indices (0..51) from a seeded shuffle — used to supply each
// seat's holes + the board for the showdown step.
function dealDistinct(rnd: () => number, count: number): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i)
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
  }
  return deck.slice(0, count)
}

type RulesReader = { read: { applyMove: (args: [viem.Hex, viem.Hex]) => Promise<viem.Hex> } }

// Blinds are still owed iff preflop and the big blind hasn't opened the action yet
// (currentBet only rises to the big blind once the BB posts).
function blindsDue(s: HoldemState): boolean {
  return s.phase === Phase.BET_PREFLOP && s.currentBet < s.bigBlind
}

// A legal move for the current state (best-effort; some may still be incomplete-raise rejects,
// which is fine — TS+Solidity must agree on the rejection).
function genLegalMove(rnd: () => number, s: HoldemState): Move {
  // blinds first: SB (no committed yet) then BB. A seat that can't cover its blind posts a
  // short all-in blind = min(stack, blind); posting the full blind would be rejected.
  if (blindsDue(s)) {
    const sbDone = s.committed.some((c) => c > 0n)
    const required = sbDone ? s.bigBlind : s.smallBlind
    const stack = s.stacks[s.toAct]!
    const amount = required < stack ? required : stack
    return { kind: 'POST_BLIND', seat: s.toAct, amount }
  }
  const seat = s.toAct
  const toCall = s.currentBet - s.committed[seat]!
  const stack = s.stacks[seat]!
  const r = rnd()
  if (toCall === 0n) {
    // Bias toward CHECK so hands frequently advance through the flop/turn/river streets
    // (the coverage assertions require BET_FLOP/BET_TURN/BET_RIVER all be reached). Still
    // bet/fold often enough to exercise aggression, all-ins and side pots.
    if (r < 0.72) return { kind: 'CHECK', seat }
    if (r < 0.76) return { kind: 'FOLD', seat }
    // BET: a legal bet is to >= currentBet + minRaise (here currentBet=0 -> >= minRaise),
    // capped at stack (all-in below min is allowed).
    const minTo = s.currentBet + s.minRaise
    const cap = s.committed[seat]! + stack
    const to = minTo <= cap ? minTo + BigInt(Math.floor(rnd() * 3)) : cap
    return { kind: 'BET', seat, to: to <= cap ? to : cap }
  }
  // facing a bet: CALL / FOLD / RAISE — bias toward CALL so the street closes and advances.
  if (r < 0.7) return { kind: 'CALL', seat }
  if (r < 0.8) return { kind: 'FOLD', seat }
  // RAISE to >= currentBet + minRaise, capped at all-in.
  const minTo = s.currentBet + s.minRaise
  const cap = s.committed[seat]! + stack
  const to = minTo <= cap ? minTo + BigInt(Math.floor(rnd() * 5)) : cap
  return { kind: 'RAISE', seat, to: to <= cap ? to : cap }
}

// A deliberately illegal move: out-of-turn, wrong blind, under-min-raise, check-facing-bet.
function genIllegalMove(rnd: () => number, s: HoldemState): Move {
  const seat = s.toAct
  const other = (seat + 1 + Math.floor(rnd() * (s.nSeats - 1))) % s.nSeats
  switch (Math.floor(rnd() * 5)) {
    case 0:
      // out of turn
      return rnd() < 0.5 ? { kind: 'CALL', seat: other } : { kind: 'CHECK', seat: other }
    case 1: {
      // wrong blind amount (only meaningful at blind time)
      if (blindsDue(s)) return { kind: 'POST_BLIND', seat: s.toAct, amount: s.smallBlind + 7n }
      // else under-min-raise
      const minTo = s.currentBet + s.minRaise
      if (minTo > 1n) return { kind: 'RAISE', seat, to: minTo - 1n }
      return { kind: 'RAISE', seat, to: s.currentBet }
    }
    case 2: {
      // check facing a bet (or call nothing)
      const toCall = s.currentBet - s.committed[seat]!
      return toCall > 0n ? { kind: 'CHECK', seat } : { kind: 'CALL', seat }
    }
    case 3:
      // raise not exceeding currentBet
      return { kind: 'RAISE', seat, to: s.currentBet }
    default:
      // bet/raise larger than stack
      return { kind: 'RAISE', seat, to: s.committed[seat]! + s.stacks[seat]! + 1000n }
  }
}

function genMove(rnd: () => number, s: HoldemState): Move {
  return rnd() < 0.18 ? genIllegalMove(rnd, s) : genLegalMove(rnd, s)
}

type WalkStats = {
  acceptedPhase: Record<number, number>
  allIns: number
  folds: number
  multiwayPots: number // states reached with ≥1 side pot
  reachedShowdown: number
  settledStates: number // SHOWDOWN moves that reached SETTLED with TS<->Sol agreement
  contestedShowdowns: number // multiway showdowns (≥2 live seats — evaluator actually ran)
  rakedShowdowns: number // settled states with rakeAccrued > 0
  shortBlinds: number // POST_BLIND moves where the poster was all-in for less than the blind
  failure: string | null
}

async function runWalk(rules: RulesReader, nSeats: number, seed: number, stats: WalkStats): Promise<void> {
  const rnd = mulberry32(seed)
  // Per-seat stacks with a LOW floor so short blinds (stack < blind, e.g. BB stack=1, bb=2)
  // are generated and the short-all-in-blind path is actually exercised. Floor is 1 (not the
  // old 20) so seats can be too poor to cover their blind; ceiling still reaches ~100.
  const stacks = Array.from({ length: nSeats }, () => 1n + BigInt(Math.floor(rnd() * 100)))
  // Exercise rake parity on ~half the walks: a non-trivial bps with a cap that bites sometimes.
  const withRake = seed % 2 === 0
  let s: HoldemState = initHoldem({
    nSeats,
    stacks,
    button: Math.floor(rnd() * nSeats),
    sb: 1n,
    bb: 2n,
    rakeBps: withRake ? 500 : 0, // 5%
    rakeCap: withRake ? 3n : 0n, // low cap so the cap path is hit on bigger pots
  })
  for (let step = 0; step < 40; step++) {
    if (s.phase === Phase.SETTLED) return
    if (s.phase === Phase.SHOWDOWN) {
      stats.reachedShowdown++
      // Resolve the showdown and assert TS<->Solidity agree on the final SETTLED state
      // (balances vector + rakeAccrued, captured by the encoded-state keccak).
      const liveSeats = s.folded.reduce((acc, f, i) => (f ? acc : [...acc, i]), [] as number[])
      const need = nSeats * 2 + 5
      const cards = dealDistinct(rnd, need)
      const holes: number[][] = []
      for (let i = 0; i < nSeats; i++) holes.push([cards[i * 2]!, cards[i * 2 + 1]!])
      const board = cards.slice(nSeats * 2, nSeats * 2 + 5)
      const move: Move = { kind: 'SHOWDOWN', holes, board }
      const tsOut = applyMove(s, move)
      if ('error' in tsOut) {
        if (!stats.failure) stats.failure = `N=${nSeats} seed ${seed}: TS rejected SHOWDOWN: ${tsOut.error}`
        return
      }
      let solBytes: viem.Hex
      try {
        solBytes = await rules.read.applyMove([encodeGameState(s), encodeMove(move)])
      } catch (e) {
        if (!stats.failure) stats.failure = `N=${nSeats} seed ${seed}: contract reverted on SHOWDOWN (TS accepted): ${(e as Error).message}`
        return
      }
      if (viem.keccak256(solBytes) !== hashGameState(tsOut.state)) {
        if (!stats.failure) stats.failure = `N=${nSeats} seed ${seed}: SHOWDOWN state hash diverged (balances/rake mismatch)`
        return
      }
      stats.settledStates++
      if (liveSeats.length >= 2) stats.contestedShowdowns++
      if (tsOut.state.rakeAccrued > 0n) stats.rakedShowdowns++
      return
    }
    // The deal phases between streets are advanced by a DEAL_DONE; mix it into the walk.
    let move: Move
    if (s.phase === Phase.DEAL_FLOP || s.phase === Phase.DEAL_TURN || s.phase === Phase.DEAL_RIVER) {
      move = { kind: 'DEAL_DONE', phase: s.phase }
    } else {
      move = genMove(rnd, s)
    }
    // A short all-in blind (poster can't cover the owed blind) — the exact C1 path. Count it
    // so the coverage assertion proves the widened fuzz actually reaches it.
    if (move.kind === 'POST_BLIND') {
      const required = blindsDue(s) && s.committed.some((c) => c > 0n) ? s.bigBlind : s.smallBlind
      if (s.stacks[move.seat]! < required) stats.shortBlinds++
    }
    const fail = (msg: string) => {
      if (!stats.failure) stats.failure = msg
    }
    // Harden against a never-throw violation of the MoveResult contract: a thrown exception
    // from TS applyMove is recorded as a DIVERGENCE (test failure with detail), not an
    // uncaught crash that would silently take down the whole gate (defense in depth — C1).
    let tsOut: ReturnType<typeof applyMove>
    try {
      tsOut = applyMove(s, move)
    } catch (e) {
      fail(`N=${nSeats} seed ${seed} step ${step}: TS applyMove THREW on ${move.kind} (must return {error}, never throw): ${(e as Error).message}`)
      return
    }
    let solOk = true
    let solBytes: viem.Hex | undefined
    try {
      solBytes = await rules.read.applyMove([encodeGameState(s), encodeMove(move)])
    } catch {
      solOk = false
    }
    if ('error' in tsOut) {
      if (solOk) {
        fail(`N=${nSeats} seed ${seed} step ${step}: TS rejected (${tsOut.error}) but contract accepted ${move.kind}`)
        return
      }
      // both rejected: stay on the same state and try another move next step.
      continue
    }
    if (!solOk) {
      fail(`N=${nSeats} seed ${seed} step ${step}: contract rejected legal ${move.kind} (TS accepted)`)
      return
    }
    if (viem.keccak256(solBytes!) !== hashGameState(tsOut.state)) {
      fail(`N=${nSeats} seed ${seed} step ${step}: state hash diverged after ${move.kind}`)
      return
    }
    s = tsOut.state
    stats.acceptedPhase[s.phase] = (stats.acceptedPhase[s.phase] ?? 0) + 1
    if (s.allIn.some((a) => a)) stats.allIns++
    if (s.folded.some((f) => f)) stats.folds++
    if (s.sidePots.length > 0) stats.multiwayPots++
  }
}

describe('Holdem TS<->Solidity parity', () => {
  // The full state is a ~1.5KB dynamic struct whose ABI-decode costs ~1.5M gas per call, so
  // every walk step is an expensive eth_call against the in-process EDR node. 180 independent
  // seeded walks (across N∈{2,3,6}) already drive every interior phase, multiple all-ins, folds
  // and multi-way side pots — the coverage assertions below FAIL the test if depth is ever lost,
  // so the count is sized for signal, not ceremony. Instrumented (solidity-coverage) runs are
  // several-fold slower and measure line coverage, not statistical depth — shrink the sweep there.
  const WALKS = process.env.SOLIDITY_COVERAGE === 'true' ? 24 : 180
  it(`${WALKS} seeded random walks agree on every betting transition (N in {2,3,6})`, async function () {
    this.timeout(420_000)
    const rules = (await hre.viem.deployContract('HoldemRules' as any, [])) as unknown as RulesReader
    const stats: WalkStats = {
      acceptedPhase: {},
      allIns: 0,
      folds: 0,
      multiwayPots: 0,
      reachedShowdown: 0,
      settledStates: 0,
      contestedShowdowns: 0,
      rakedShowdowns: 0,
      shortBlinds: 0,
      failure: null,
    }
    const seatsFor = (seed: number) => [2, 3, 6][seed % 3]!
    const BATCH = 30
    for (let base = 1; base <= WALKS && !stats.failure; base += BATCH) {
      const batch: Promise<void>[] = []
      for (let seed = base; seed < base + BATCH && seed <= WALKS; seed++) {
        batch.push(runWalk(rules, seatsFor(seed), seed, stats))
      }
      await Promise.all(batch)
    }
    expect(stats.failure, stats.failure ?? 'parity drift').to.equal(null)
    // Coverage: the fuzz is worthless if it never reaches deep states. Prove depth.
    expect(stats.allIns, 'no walk ever produced an all-in').to.be.greaterThan(0)
    expect(stats.folds, 'no walk ever produced a fold').to.be.greaterThan(0)
    expect(stats.multiwayPots, 'no walk ever produced a side pot').to.be.greaterThan(0)
    expect(stats.reachedShowdown, 'no walk ever reached showdown').to.be.greaterThan(0)
    // Task 7: the SHOWDOWN move resolved to a SETTLED state and TS<->Sol agreed on balances+rake.
    expect(stats.settledStates, 'no walk ever settled a showdown (Task 7 unexercised)').to.be.greaterThan(0)
    expect(stats.contestedShowdowns, 'no MULTIWAY showdown (evaluator never ran in parity)').to.be.greaterThan(0)
    expect(stats.rakedShowdowns, 'no settled state ever accrued rake (rake parity unexercised)').to.be.greaterThan(0)
    // C1: the fuzz must actually exercise the short-all-in-blind path (poster stack < blind),
    // and TS+Solidity agreed on it above (accept/reject + post-move state hash).
    expect(stats.shortBlinds, 'no walk ever produced a short all-in blind (C1 path unexercised)').to.be.greaterThan(0)
    // Every interior betting street reached by an accepted transition at least once.
    for (const p of [Phase.BET_PREFLOP, Phase.BET_FLOP, Phase.BET_TURN, Phase.BET_RIVER, Phase.SHOWDOWN]) {
      expect(stats.acceptedPhase[p] ?? 0, `phase ${p} never reached by an accepted transition`).to.be.greaterThan(0)
    }
  })

  it('whoseTurn names exactly the seats that owe (spot states)', async () => {
    const rules = await hre.viem.deployContract('HoldemRules' as any, [])
    const turn = async (s: HoldemState) => rules.read.whoseTurn([encodeGameState(s)])
    const apply = (s: HoldemState, m: Move): HoldemState => {
      const r = applyMove(s, m)
      if ('error' in r) throw new Error(r.error)
      return r.state
    }
    // N=3, button 0: after blinds preflop, only UTG (seat 0) owes -> mask 0b001.
    {
      let s = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n })
      s = apply(s, { kind: 'POST_BLIND', seat: 1, amount: 1n })
      s = apply(s, { kind: 'POST_BLIND', seat: 2, amount: 2n })
      expect(s.toAct).to.equal(0)
      expect(whoseTurn(s)).to.equal(1n)
      expect(await turn(s)).to.equal(1n)
    }
    // After UTG calls, SB (seat 1) owes -> mask 0b010.
    {
      let s = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n })
      s = apply(s, { kind: 'POST_BLIND', seat: 1, amount: 1n })
      s = apply(s, { kind: 'POST_BLIND', seat: 2, amount: 2n })
      s = apply(s, { kind: 'CALL', seat: 0 })
      expect(whoseTurn(s)).to.equal(2n)
      expect(await turn(s)).to.equal(2n)
    }
    // A DEAL_FLOP state: every live seat owes board progress.
    {
      let s = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n })
      s = apply(s, { kind: 'POST_BLIND', seat: 1, amount: 1n })
      s = apply(s, { kind: 'POST_BLIND', seat: 2, amount: 2n })
      s = apply(s, { kind: 'FOLD', seat: 0 })
      s = apply(s, { kind: 'CALL', seat: 1 })
      s = apply(s, { kind: 'CHECK', seat: 2 })
      expect(s.phase).to.equal(Phase.DEAL_FLOP)
      // seats 1 & 2 live -> mask 0b110
      expect(whoseTurn(s)).to.equal(6n)
      expect(await turn(s)).to.equal(6n)
    }
    // SHOWDOWN (uncontested): nobody owes -> mask 0.
    {
      let s = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n })
      s = apply(s, { kind: 'POST_BLIND', seat: 1, amount: 1n })
      s = apply(s, { kind: 'POST_BLIND', seat: 2, amount: 2n })
      s = apply(s, { kind: 'FOLD', seat: 0 })
      s = apply(s, { kind: 'FOLD', seat: 1 })
      expect(s.phase).to.equal(Phase.SHOWDOWN)
      expect(whoseTurn(s)).to.equal(0n)
      expect(await turn(s)).to.equal(0n)
    }
  })
})
