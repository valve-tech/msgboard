import { describe, it, expect } from 'vitest'
import {
  Phase,
  initHoldem,
  applyMove,
  conserved,
  type HoldemState,
  type Move,
} from '../src/rules'

// Card index helper: index = (rank-2)*4 + suit. rank 2..14 (14=Ace), suit 0..3.
const card = (rank: number, suit: number): number => (rank - 2) * 4 + suit
// Suits
const S = 0
const H = 1
const D = 2
const C = 3

// Drive a hand to a multiway SHOWDOWN with a known pot layout by hand-constructing the state.
// We bypass the betting machine for the targeted distribution tests by building the SHOWDOWN
// state directly (folded/allIn/pot/sidePots set), which is exactly the state `finishHand`
// leaves for a multiway showdown.
function showdownState(args: {
  nSeats: number
  button?: number
  stacks: bigint[] // leftover behind (usually 0n after all-in showdowns)
  folded?: boolean[]
  pot: bigint
  sidePots?: { amount: bigint; eligible: number[] }[]
  rakeBps?: number
  rakeCap?: bigint
  totalContributed: bigint[]
}): HoldemState {
  const n = args.nSeats
  return {
    phase: Phase.SHOWDOWN,
    nSeats: n,
    button: args.button ?? 0,
    toAct: -1,
    stacks: [...args.stacks],
    committed: Array(n).fill(0n),
    totalContributed: [...args.totalContributed],
    folded: args.folded ? [...args.folded] : Array(n).fill(false),
    allIn: Array(n).fill(false),
    currentBet: 0n,
    minRaise: 0n,
    lastAggressor: -1,
    actedSinceAggression: Array(n).fill(false),
    pot: args.pot,
    sidePots: (args.sidePots ?? []).map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
    smallBlind: 1n,
    bigBlind: 2n,
    rakeBps: args.rakeBps ?? 0,
    rakeCap: args.rakeCap ?? 0n,
    stubWinner: -1,
    rakeAccrued: 0n,
  }
}

// Σ totalContributed == escrow-into-pot; after showdown Σ balances + rake must equal it
// plus whatever sat in stacks (uncommitted behind). For these targeted tests stacks are 0.
function potTotal(s: HoldemState): bigint {
  let t = s.pot
  for (const sp of s.sidePots) t += sp.amount
  return t
}

describe("Hold'em showdown — distribution + rake + conservation", () => {
  it('single-pot showdown: best hand wins pot − rake; conservation holds', () => {
    // N=3, all called; pot = 30 (10 each). Board gives seat 2 the nuts.
    // Board: As Ks Qs Js Ts? no — keep it simple. Use a board + holes with a clear winner.
    const board = [card(14, S), card(13, S), card(7, H), card(2, D), card(3, C)] // A♠ K♠ 7♥ 2♦ 3♣
    const holes = [
      [card(14, H), card(14, D)], // seat 0: AA -> trip aces (pair w/ board ace) actually two pair? AA + A = trips
      [card(13, H), card(13, D)], // seat 1: KK + K = trips kings
      [card(14, C), card(13, C)], // seat 2: AK -> two pair aces & kings (A from board + K from board)
    ]
    // seat 0 has three aces (A♥ A♦ + A♠), best. winner = seat 0.
    const s = showdownState({
      nSeats: 3,
      stacks: [0n, 0n, 0n],
      pot: 30n,
      totalContributed: [10n, 10n, 10n],
      rakeBps: 500, // 5%
      rakeCap: 100n,
    })
    const total = potTotal(s)
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    const out = r.state
    expect(out.phase).toBe(Phase.SETTLED)
    expect(out.pot).toBe(0n)
    expect(out.sidePots).toEqual([])
    // rake = 5% of 30 = 1.5 -> floor 1
    expect(out.rakeAccrued).toBe(1n)
    // seat 0 wins 30 - 1 = 29
    expect(out.stacks[0]).toBe(29n)
    expect(out.stacks[1]).toBe(0n)
    expect(out.stacks[2]).toBe(0n)
    // conservation: Σ balances + rake == total pot
    const sumBal = out.stacks.reduce((a, b) => a + b, 0n)
    expect(sumBal + out.rakeAccrued).toBe(total)
  })

  it('rake = 0: winner takes the whole pot', () => {
    const board = [card(14, S), card(13, S), card(7, H), card(2, D), card(3, C)]
    const holes = [
      [card(14, H), card(14, D)],
      [card(13, H), card(13, D)],
      [card(14, C), card(13, C)],
    ]
    const s = showdownState({ nSeats: 3, stacks: [0n, 0n, 0n], pot: 30n, totalContributed: [10n, 10n, 10n], rakeBps: 0, rakeCap: 0n })
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    expect(r.state.rakeAccrued).toBe(0n)
    expect(r.state.stacks[0]).toBe(30n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n)).toBe(30n)
  })

  it('rake at cap: rake bounded by rakeCap', () => {
    const board = [card(14, S), card(13, S), card(7, H), card(2, D), card(3, C)]
    const holes = [
      [card(14, H), card(14, D)],
      [card(13, H), card(13, D)],
      [card(14, C), card(13, C)],
    ]
    // pot 1000, rakeBps 1000 (10%) => 100 uncapped, cap 7 => rake 7.
    const s = showdownState({ nSeats: 3, stacks: [0n, 0n, 0n], pot: 1000n, totalContributed: [400n, 300n, 300n], rakeBps: 1000, rakeCap: 7n })
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    expect(r.state.rakeAccrued).toBe(7n)
    expect(r.state.stacks[0]).toBe(993n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n) + r.state.rakeAccrued).toBe(1000n)
  })

  it('2-way tie: split equally (even pot, no remainder)', () => {
    // Both seat 0 and seat 1 make the same straight off the board; seat 2 worse.
    // Board: 5♣ 6♦ 7♥ 8♠ 2♣ ; seat0 9♠/2♥ -> 9-high straight (5-9); seat1 9♦/2♦ -> same 9-high straight.
    const board = [card(5, C), card(6, D), card(7, H), card(8, S), card(2, C)]
    const holes = [
      [card(9, S), card(3, H)], // 9-high straight 5-6-7-8-9
      [card(9, D), card(3, D)], // 9-high straight 5-6-7-8-9 (tie)
      [card(2, S), card(2, D)], // pair of deuces (board 2 + two more) trips actually -> trips 2s, loses to straight
    ]
    const s = showdownState({ nSeats: 3, stacks: [0n, 0n, 0n], pot: 30n, totalContributed: [10n, 10n, 10n], rakeBps: 0, rakeCap: 0n })
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    expect(r.state.stacks[0]).toBe(15n)
    expect(r.state.stacks[1]).toBe(15n)
    expect(r.state.stacks[2]).toBe(0n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n)).toBe(30n)
  })

  it('3-way tie with odd chip: remainder to earliest seat left of button', () => {
    // All three play the board (a straight on the board) -> 3-way tie. pot 31 -> 10,10,11.
    // odd chip to first eligible seat left of button. button=0 -> button+1 = seat 1 first.
    // Board: 10♣ J♦ Q♥ K♠ A♣  (a Broadway straight on the board)
    const board = [card(10, C), card(11, D), card(12, H), card(13, S), card(14, C)]
    const holes = [
      [card(2, S), card(3, H)], // plays the board -> Broadway
      [card(2, D), card(4, H)], // plays the board -> Broadway
      [card(2, C), card(5, H)], // plays the board -> Broadway
    ]
    const s = showdownState({ nSeats: 3, button: 0, stacks: [0n, 0n, 0n], pot: 31n, totalContributed: [11n, 10n, 10n], rakeBps: 0, rakeCap: 0n })
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    // base 10 each; remainder 1 to first left-of-button (seat 1).
    expect(r.state.stacks[1]).toBe(11n)
    expect(r.state.stacks[0]).toBe(10n)
    expect(r.state.stacks[2]).toBe(10n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n)).toBe(31n)
  })

  it('multi side-pot: short all-in wins only the main pot', () => {
    // seat 0 all-in 10 (short), seats 1,2 contribute 30 each.
    // main pot = 30 (10*3), eligible {0,1,2}; side pot = 40 (20*2), eligible {1,2}.
    // seat 0 has the best hand overall but is only eligible for the main pot.
    // seat 1 wins the side pot.
    // Board: A♠ K♠ 7♥ 2♦ 3♣
    const board = [card(14, S), card(13, S), card(7, H), card(2, D), card(3, C)]
    const holes = [
      [card(14, H), card(14, D)], // seat0: trips aces (best overall) -> wins MAIN only
      [card(13, H), card(13, D)], // seat1: trips kings -> wins SIDE
      [card(7, S), card(7, C)], // seat2: trips sevens (worst of the three)
    ]
    const s = showdownState({
      nSeats: 3,
      button: 0,
      stacks: [0n, 0n, 0n],
      pot: 30n,
      sidePots: [{ amount: 40n, eligible: [1, 2] }],
      totalContributed: [10n, 30n, 30n],
      rakeBps: 0,
      rakeCap: 0n,
    })
    const total = potTotal(s)
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    expect(r.state.stacks[0]).toBe(30n) // main pot only
    expect(r.state.stacks[1]).toBe(40n) // side pot
    expect(r.state.stacks[2]).toBe(0n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n)).toBe(total)
  })

  it('fold-to-win: everyone folds to one seat — pot − rake to last seat, no evaluation', () => {
    // This is the uncontested path: finishHand already sweeps. Drive it through betting.
    const s0 = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n, rakeBps: 500, rakeCap: 100n })
    const escrow = 300n
    let s = applyMoveOk(s0, { kind: 'POST_BLIND', seat: 1, amount: 1n })
    s = applyMoveOk(s, { kind: 'POST_BLIND', seat: 2, amount: 2n })
    s = applyMoveOk(s, { kind: 'FOLD', seat: 0 })
    s = applyMoveOk(s, { kind: 'FOLD', seat: 1 })
    // seat 2 uncontested winner; finishHand swept the pot already (stubWinner path).
    expect(s.phase).toBe(Phase.SHOWDOWN)
    expect(s.stubWinner).toBe(2)
    // Now SHOWDOWN move on an uncontested (already-swept) hand finalizes to SETTLED, applying
    // rake to the swept winnings. seat 2 won 3 (1+2 blinds). rake 5% of 3 = 0 (floor). Provide
    // dummy holes/board (ignored for the uncontested winner but the move must still be accepted).
    const r = applyMove(s, { kind: 'SHOWDOWN', holes: [[0, 1], [2, 3], [4, 5]], board: [6, 7, 8, 9, 10] })
    if ('error' in r) throw new Error(r.error)
    expect(r.state.phase).toBe(Phase.SETTLED)
    // conservation against escrow
    const sumBal = r.state.stacks.reduce((a, b) => a + b, 0n)
    expect(sumBal + r.state.rakeAccrued).toBe(escrow)
  })

  it('SHOWDOWN rejected outside the SHOWDOWN phase', () => {
    const s0 = initHoldem({ nSeats: 3, stacks: [100n, 100n, 100n], button: 0, sb: 1n, bb: 2n })
    const r = applyMove(s0, { kind: 'SHOWDOWN', holes: [[0, 1], [2, 3], [4, 5]], board: [6, 7, 8, 9, 10] })
    expect('error' in r).toBe(true)
  })

  it('no rake on an uncalled-return side pot (single eligible seat)', () => {
    // seats: 0 all-in 50, 1 all-in 10, 2 all-in 10. main pot 30 ({0,1,2}); side pot 40 ({0}).
    // The side pot has a single eligible seat -> uncalled return, NO rake on it.
    // seat 1 wins the main pot. Total rake only on the main (contested) pot.
    const board = [card(14, S), card(13, S), card(7, H), card(2, D), card(3, C)]
    const holes = [
      [card(2, H), card(3, S)], // seat0: nothing (pair of 2s/3s) -> loses main, but gets uncalled side back
      [card(14, H), card(14, D)], // seat1: trips aces -> wins main
      [card(13, H), card(13, D)], // seat2: trips kings
    ]
    const s = showdownState({
      nSeats: 3,
      button: 0,
      stacks: [0n, 0n, 0n],
      pot: 30n,
      sidePots: [{ amount: 40n, eligible: [0] }],
      totalContributed: [50n, 10n, 10n],
      rakeBps: 1000, // 10%
      rakeCap: 1000n,
      folded: [false, false, false],
    })
    const total = potTotal(s)
    const r = applyMove(s, { kind: 'SHOWDOWN', holes, board })
    if ('error' in r) throw new Error(r.error)
    // rake only on main pot 30 -> 10% = 3. side pot 40 returned to seat 0 untouched.
    expect(r.state.rakeAccrued).toBe(3n)
    expect(r.state.stacks[0]).toBe(40n) // uncalled return, no rake
    expect(r.state.stacks[1]).toBe(27n) // 30 - 3 rake
    expect(r.state.stacks[2]).toBe(0n)
    expect(r.state.stacks.reduce((a, b) => a + b, 0n) + r.state.rakeAccrued).toBe(total)
  })
})

function applyMoveOk(s: HoldemState, m: Move): HoldemState {
  const r = applyMove(s, m)
  if ('error' in r) throw new Error(`unexpected reject ${m.kind}: ${r.error}`)
  return r.state
}
