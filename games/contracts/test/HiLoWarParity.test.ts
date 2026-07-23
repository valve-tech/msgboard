import { expect } from 'chai'
import hre from 'hardhat'
import * as viem from 'viem'
import {
  initialFlipState,
  applyMove,
  hashBetCommit,
  Phase,
  type HiLoState,
  type Move,
  type Seat,
  type Bet,
} from '@msgboard/hilo-war'
import { encodeGameState, encodeMove, hashGameStateAbi } from '@msgboard/hilo-war'

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

const REVEAL = viem.zeroAddress
const SHUFFLE = viem.zeroAddress

const SEATS: Seat[] = ['A', 'B']
const BETS: Bet[] = ['RAISE', 'HOLD']

// A random 32-byte salt from the PRNG (32 hex bytes).
const randSalt = (rnd: () => number): viem.Hex => {
  let s = '0x'
  for (let i = 0; i < 32; i++) s += Math.floor(rnd() * 256).toString(16).padStart(2, '0')
  return s as viem.Hex
}

const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

// Per-walk memory of the (bet, salt, commitment) each seat committed to, so a later
// BET_OPEN can present the matching salt+bet (and the contract recomputes the same hash).
type Commit = { bet: Bet; salt: viem.Hex; commitment: viem.Hex }
type SaltMap = Partial<Record<Seat, Commit>>

const ALL_KINDS: Move['kind'][] = ['DEAL_DONE', 'BET_COMMIT', 'BET_OPEN', 'CALL', 'FOLD', 'SHOWDOWN']

// Build a deliberately illegal / out-of-phase / corrupted move. TS and Solidity must
// AGREE on rejecting it (both throw / both return an error).
function genIllegalMove(rnd: () => number, ts: HiLoState, salts: SaltMap): Move {
  const flavor = Math.floor(rnd() * 5)
  switch (flavor) {
    case 0: {
      // Random (likely out-of-phase) kind with plausible-but-arbitrary fields.
      const kind = pick(rnd, ALL_KINDS)
      switch (kind) {
        case 'DEAL_DONE': return { kind: 'DEAL_DONE' }
        case 'BET_COMMIT': return { kind: 'BET_COMMIT', by: pick(rnd, SEATS), commitment: randSalt(rnd) }
        case 'BET_OPEN': return { kind: 'BET_OPEN', by: pick(rnd, SEATS), bet: pick(rnd, BETS), salt: randSalt(rnd) }
        case 'CALL': return { kind: 'CALL', by: pick(rnd, SEATS) }
        case 'FOLD': return { kind: 'FOLD', by: pick(rnd, SEATS) }
        case 'SHOWDOWN': return { kind: 'SHOWDOWN', cardA: Math.floor(rnd() * 52), cardB: Math.floor(rnd() * 52) }
      }
    }
    // falls through (unreachable) — switch above always returns
    case 1: {
      // BET_OPEN with a corrupted salt -> commitment mismatch (in BET_OPEN phase).
      const committed = SEATS.filter((s) => salts[s])
      const by = committed.length ? pick(rnd, committed) : pick(rnd, SEATS)
      const c = salts[by]
      return { kind: 'BET_OPEN', by, bet: c?.bet ?? pick(rnd, BETS), salt: randSalt(rnd) }
    }
    case 2: {
      // SHOWDOWN with a bad / duplicate card.
      const card = pick(rnd, [52, 99] as const)
      return rnd() < 0.5
        ? { kind: 'SHOWDOWN', cardA: card, cardB: 0 }
        : { kind: 'SHOWDOWN', cardA: 7, cardB: 7 }
    }
    case 3: {
      // Duplicate commit by a seat that already committed.
      const committed = SEATS.filter((s) => salts[s])
      const by = committed.length ? pick(rnd, committed) : pick(rnd, SEATS)
      return { kind: 'BET_COMMIT', by, commitment: randSalt(rnd) }
    }
    default: {
      // Wrong-seat action in CALL_OR_FOLD (raiser acting) or a duplicate open.
      if (ts.phase === Phase.CALL_OR_FOLD && ts.raiser) {
        return rnd() < 0.5 ? { kind: 'CALL', by: ts.raiser } : { kind: 'FOLD', by: ts.raiser }
      }
      const opened = SEATS.filter((s) => ts.bets[s] && salts[s])
      if (opened.length) {
        const by = pick(rnd, opened)
        const c = salts[by]!
        // Duplicate open by a seat that already opened — rejected by both engines.
        return { kind: 'BET_OPEN', by, bet: c.bet, salt: c.salt }
      }
      // No seat-specific illegality available; fall back to an out-of-phase DEAL_DONE.
      return { kind: 'DEAL_DONE' }
    }
  }
}

// Build a legal move appropriate to ts.phase. For BET_COMMIT it records the fresh
// (bet,salt,commitment) in `salts` so the matching BET_OPEN can be produced later.
function genLegalMove(rnd: () => number, ts: HiLoState, salts: SaltMap): Move {
  switch (ts.phase) {
    case Phase.DEAL:
      return { kind: 'DEAL_DONE' }
    case Phase.BET_COMMIT: {
      const pending = SEATS.filter((s) => !ts.commits[s])
      const by = pick(rnd, pending)
      const bet = pick(rnd, BETS)
      const salt = randSalt(rnd)
      const commitment = hashBetCommit(bet, salt)
      salts[by] = { bet, salt, commitment }
      return { kind: 'BET_COMMIT', by, commitment }
    }
    case Phase.BET_OPEN: {
      // Prefer a seat whose commit we recorded (so we can present a matching salt).
      // An accidental commit from the illegal branch may have used a random commitment
      // we never stored; opening such a seat is impossible-to-satisfy, so TS+Solidity
      // both reject it — still a valid parity check, just not a "legal" transition.
      const pending = SEATS.filter((s) => !ts.bets[s])
      const known = pending.filter((s) => salts[s])
      const by = pick(rnd, known.length ? known : pending)
      const c = salts[by]
      return c
        ? { kind: 'BET_OPEN', by, bet: c.bet, salt: c.salt }
        : { kind: 'BET_OPEN', by, bet: pick(rnd, BETS), salt: randSalt(rnd) }
    }
    case Phase.CALL_OR_FOLD: {
      const by: Seat = ts.raiser === 'A' ? 'B' : 'A'
      return rnd() < 0.5 ? { kind: 'CALL', by } : { kind: 'FOLD', by }
    }
    case Phase.SHOWDOWN: {
      const cardA = Math.floor(rnd() * 52)
      let cardB = Math.floor(rnd() * 52)
      if (cardB === cardA) cardB = (cardB + 1) % 52
      return { kind: 'SHOWDOWN', cardA, cardB }
    }
    default:
      // Unreachable in the walk (terminal phases end it), but keep total.
      return { kind: 'DEAL_DONE' }
  }
}

function genMove(rnd: () => number, ts: HiLoState, salts: SaltMap): Move {
  return rnd() < 0.25 ? genIllegalMove(rnd, ts, salts) : genLegalMove(rnd, ts, salts)
}

// Aggregated, mutable coverage/result accounting shared by every walk.
type WalkStats = {
  accepted: Record<number, number>
  showdowns: number
  folds: number
  reachedTerminal: number
  failure: string | null
}

// Minimal structural view of the deployed HiLoWarRules instance — only the read path
// this fuzz exercises. Avoids pinning to a generated contract type (deployContract's
// loose `'HiLoWarRules' as any` instance does not unify with the first-overload type
// that `Awaited<ReturnType<...>>` resolves to).
type RulesReader = { read: { applyMove: (args: [viem.Hex, viem.Hex]) => Promise<viem.Hex> } }

// Run one independent seeded walk, asserting TS<->Solidity agreement at every step.
// Records a human-readable `failure` (seed/step/move) on the FIRST divergence and stops
// that walk; coverage counters fold into the shared `stats`.
async function runWalk(
  rules: RulesReader,
  seed: number,
  stats: WalkStats,
): Promise<void> {
  const rnd = mulberry32(seed)
  const salts: SaltMap = {}
  let ts: HiLoState = initialFlipState({ ante: 1n + BigInt(Math.floor(rnd() * 5)), deckIndex: 0, warPot: 0n })
  for (let step = 0; step < 12; step++) {
    const move = genMove(rnd, ts, salts)
    const tsOut = applyMove(ts, move)
    let solOk = true
    let solBytes: viem.Hex | undefined
    try {
      solBytes = await rules.read.applyMove([encodeGameState(ts), encodeMove(move)])
    } catch {
      solOk = false
    }
    const fail = (msg: string) => {
      if (!stats.failure) stats.failure = msg
    }
    if ('error' in tsOut) {
      if (solOk) {
        fail(`seed ${seed} step ${step}: TS rejected (${tsOut.error}) but contract accepted ${move.kind}`)
        return
      }
    } else {
      if (!solOk) {
        fail(`seed ${seed} step ${step}: contract rejected legal ${move.kind}`)
        return
      }
      if (viem.keccak256(solBytes!) !== hashGameStateAbi(tsOut.state)) {
        fail(`seed ${seed} step ${step}: state hash diverged after ${move.kind}`)
        return
      }
      if (move.kind === 'SHOWDOWN') stats.showdowns++
      if (move.kind === 'FOLD') stats.folds++
      ts = tsOut.state
      stats.accepted[ts.phase] = (stats.accepted[ts.phase] ?? 0) + 1
      if (ts.phase >= Phase.FLIP_DONE) {
        stats.reachedTerminal++
        return
      }
    }
  }
}

describe('HiLoWar TS<->Solidity parity', () => {
  // Instrumented (solidity-coverage) runs are several-fold slower and measure line coverage,
  // not statistical depth — shrink the sweep there; the full 500 walks run uninstrumented.
  const WALKS = process.env.SOLIDITY_COVERAGE === 'true' ? 60 : 500
  it(`${WALKS} seeded random walks agree on every transition`, async function () {
    this.timeout(240_000)
    const rules = (await hre.viem.deployContract('HiLoWarRules' as any, [REVEAL, SHUFFLE])) as unknown as RulesReader
    const stats: WalkStats = { accepted: {}, showdowns: 0, folds: 0, reachedTerminal: 0, failure: null }
    // Walks are independent; run them in concurrent batches so the in-process hardhat
    // node stays busy and the walk sweep fits comfortably under the timeout.
    const BATCH = 50
    for (let base = 1; base <= WALKS && !stats.failure; base += BATCH) {
      const batch: Promise<void>[] = []
      for (let seed = base; seed < base + BATCH && seed <= WALKS; seed++) {
        batch.push(runWalk(rules, seed, stats))
      }
      await Promise.all(batch)
    }
    // Surface the first divergence loudly with its seed/step/move.
    expect(stats.failure, stats.failure ?? 'parity drift').to.equal(null)
    const { accepted, showdowns, folds, reachedTerminal } = stats
    // The fuzz is worthless if it never reaches deep states. Prove it did.
    expect(showdowns, 'generator never produced an accepted SHOWDOWN').to.be.greaterThan(0)
    expect(folds, 'generator never produced an accepted FOLD').to.be.greaterThan(0)
    expect(reachedTerminal, 'no walk ever reached a terminal flip state').to.be.greaterThan(0)
    // Confirm every interior phase was visited at least once by an accepted move.
    for (const p of [Phase.BET_COMMIT, Phase.BET_OPEN, Phase.CALL_OR_FOLD, Phase.SHOWDOWN, Phase.FLIP_DONE]) {
      expect(accepted[p] ?? 0, `phase ${p} never reached by an accepted transition`).to.be.greaterThan(0)
    }
  })

  it('whoseTurn agrees with which seats have pending TS moves (spot states)', async () => {
    const rules = await hre.viem.deployContract('HiLoWarRules' as any, [REVEAL, SHUFFLE])
    const SALT_A = ('0x' + 'a1'.repeat(32)) as viem.Hex
    const SALT_B = ('0x' + 'b2'.repeat(32)) as viem.Hex
    const apply = (s: HiLoState, m: Move): HiLoState => {
      const r = applyMove(s, m)
      if ('error' in r) throw new Error(r.error)
      return r.state
    }
    const fresh = () => initialFlipState({ ante: 1n, deckIndex: 0, warPot: 0n })
    const turn = async (s: HiLoState) => rules.read.whoseTurn([encodeGameState(s)])

    // Fresh DEAL: both seats owe the deal step (mask 3).
    {
      const s = fresh()
      expect(s.phase).to.equal(Phase.DEAL)
      expect(await turn(s)).to.equal(3)
    }
    // Half-committed BET_COMMIT: A committed, only B owes (mask 2).
    {
      let s = apply(fresh(), { kind: 'DEAL_DONE' })
      s = apply(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      expect(s.phase).to.equal(Phase.BET_COMMIT)
      expect(await turn(s)).to.equal(2)
    }
    // Half-open BET_OPEN: A opened, only B owes (mask 2).
    {
      let s = apply(fresh(), { kind: 'DEAL_DONE' })
      s = apply(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('RAISE', SALT_A) })
      s = apply(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = apply(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      expect(s.phase).to.equal(Phase.BET_OPEN)
      expect(await turn(s)).to.equal(2)
    }
    // CALL_OR_FOLD, raiser A: only B owes (mask 2).
    {
      let s = apply(fresh(), { kind: 'DEAL_DONE' })
      s = apply(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('RAISE', SALT_A) })
      s = apply(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('HOLD', SALT_B) })
      s = apply(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: SALT_A })
      s = apply(s, { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: SALT_B })
      expect(s.phase).to.equal(Phase.CALL_OR_FOLD)
      expect(s.raiser).to.equal('A')
      expect(await turn(s)).to.equal(2)
    }
    // CALL_OR_FOLD, raiser B: only A owes (mask 1).
    {
      let s = apply(fresh(), { kind: 'DEAL_DONE' })
      s = apply(s, { kind: 'BET_COMMIT', by: 'A', commitment: hashBetCommit('HOLD', SALT_A) })
      s = apply(s, { kind: 'BET_COMMIT', by: 'B', commitment: hashBetCommit('RAISE', SALT_B) })
      s = apply(s, { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: SALT_A })
      s = apply(s, { kind: 'BET_OPEN', by: 'B', bet: 'RAISE', salt: SALT_B })
      expect(s.phase).to.equal(Phase.CALL_OR_FOLD)
      expect(s.raiser).to.equal('B')
      expect(await turn(s)).to.equal(1)
    }
    // FLIP_DONE: the flip is over, but both parties still owe protocol progress
    // (the next co-signed state / settlement). Only SETTLED zeroes the mask. (mask 3)
    {
      const s: HiLoState = { ...fresh(), phase: Phase.FLIP_DONE }
      expect(await turn(s)).to.equal(3)
    }
    // SETTLED: channel-level terminal, nobody owes (mask 0).
    {
      const s: HiLoState = { ...fresh(), phase: Phase.SETTLED }
      expect(await turn(s)).to.equal(0)
    }
  })
})
