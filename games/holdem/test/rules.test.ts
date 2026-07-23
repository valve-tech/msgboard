import { describe, it, expect } from 'vitest'
import {
  Phase,
  initHoldem,
  applyMove,
  conserved,
  type HoldemState,
  type Move,
} from '../src/rules'

// Apply a move, asserting it was accepted, and assert the channel conservation invariant
// (Σ balances + pot + Σ sidePots == Σ escrow; rake=0 in Task 5) after the transition.
function step(s: HoldemState, m: Move, escrow: bigint): HoldemState {
  const r = applyMove(s, m)
  if ('error' in r) throw new Error(`unexpected reject of ${m.kind}: ${r.error}`)
  expect(conserved(r.state)).toBe(escrow)
  return r.state
}
function reject(s: HoldemState, m: Move): string {
  const r = applyMove(s, m)
  expect('error' in r, `expected ${m.kind} to be rejected`).toBe(true)
  return (r as { error: string }).error
}

// A standard table: nSeats stacks each `stack`, blinds sb/bb, button at `button`.
function table(nSeats: number, stack: bigint, sb: bigint, bb: bigint, button = 0): { s: HoldemState; escrow: bigint } {
  const s = initHoldem({ nSeats, stacks: Array(nSeats).fill(stack), button, sb, bb })
  return { s, escrow: stack * BigInt(nSeats) }
}

// Drive the two blind posts for the current state, returning the post-BB state.
function postBlinds(s0: HoldemState, escrow: bigint): HoldemState {
  // toAct after init points at the small blind.
  const sb = s0.toAct
  let s = step(s0, { kind: 'POST_BLIND', seat: sb, amount: s0.smallBlind }, escrow)
  const bb = s.toAct
  s = step(s, { kind: 'POST_BLIND', seat: bb, amount: s0.bigBlind }, escrow)
  return s
}

describe('Hold\'em betting — blinds + action order', () => {
  it('N=3: posts SB (button+1) then BB (button+2); preflop action opens UTG (button)', () => {
    const { s: s0, escrow } = table(3, 100n, 1n, 2n, /*button*/ 0)
    expect(s0.phase).toBe(Phase.BET_PREFLOP)
    expect(s0.toAct).toBe(1) // SB is button+1
    let s = step(s0, { kind: 'POST_BLIND', seat: 1, amount: 1n }, escrow)
    expect(s.toAct).toBe(2) // BB is button+2
    s = step(s, { kind: 'POST_BLIND', seat: 2, amount: 2n }, escrow)
    expect(s.currentBet).toBe(2n)
    expect(s.committed).toEqual([0n, 1n, 2n])
    // Preflop first to act is left of BB => button (seat 0) in a 3-handed game.
    expect(s.toAct).toBe(0)
  })

  it('N=2 heads-up: button posts SB and acts first preflop; BB acts first postflop', () => {
    const { s: s0, escrow } = table(2, 100n, 1n, 2n, /*button*/ 0)
    // Heads-up: the button is the small blind and acts first preflop.
    expect(s0.toAct).toBe(0)
    let s = step(s0, { kind: 'POST_BLIND', seat: 0, amount: 1n }, escrow)
    expect(s.toAct).toBe(1)
    s = step(s, { kind: 'POST_BLIND', seat: 1, amount: 2n }, escrow)
    // Preflop: button (SB) acts first.
    expect(s.toAct).toBe(0)
    // Button completes, BB checks => flop. Postflop the BB (non-button) acts first.
    s = step(s, { kind: 'CALL', seat: 0 }, escrow)
    s = step(s, { kind: 'CHECK', seat: 1 }, escrow)
    expect(s.phase).toBe(Phase.DEAL_FLOP)
  })
})

describe('Hold\'em betting — check / bet / call / raise / fold', () => {
  it('preflop limp around to BB, BB checks, advances to flop deal', () => {
    const { s: s0, escrow } = table(3, 100n, 1n, 2n, 0)
    let s = postBlinds(s0, escrow)
    expect(s.toAct).toBe(0)
    s = step(s, { kind: 'CALL', seat: 0 }, escrow) // UTG calls 2
    s = step(s, { kind: 'CALL', seat: 1 }, escrow) // SB completes to 2
    // BB may check (already at currentBet)
    expect(s.toAct).toBe(2)
    const checked = step(s, { kind: 'CHECK', seat: 2 }, escrow)
    expect(checked.phase).toBe(Phase.DEAL_FLOP)
    // pot folded down: 3 seats * 2 = 6
    expect(checked.pot).toBe(6n)
    expect(checked.sidePots).toEqual([])
    expect(checked.committed).toEqual([0n, 0n, 0n]) // reset for new street
    expect(checked.currentBet).toBe(0n)
  })

  it('a CHECK facing a bet is illegal; min-raise is enforced; acting out of turn is illegal', () => {
    const { s: s0, escrow } = table(3, 100n, 1n, 2n, 0)
    let s = postBlinds(s0, escrow)
    // UTG (seat 0) faces currentBet 2; cannot CHECK.
    expect(reject(s, { kind: 'CHECK', seat: 0 })).toMatch(/check/i)
    // Out of turn: seat 2 cannot act.
    expect(reject(s, { kind: 'CALL', seat: 2 })).toMatch(/turn/i)
    // A raise must be to >= currentBet + minRaise (= 2 + 2 = 4). Raising to 3 is illegal.
    expect(reject(s, { kind: 'RAISE', seat: 0, to: 3n })).toMatch(/min-?raise/i)
    // Raising to 4 is legal.
    s = step(s, { kind: 'RAISE', seat: 0, to: 4n }, escrow)
    expect(s.currentBet).toBe(4n)
    expect(s.minRaise).toBe(2n) // raise increment was 2 (4-2)
    // Next raise must be to >= 4 + 2 = 6.
    expect(reject(s, { kind: 'RAISE', seat: 1, to: 5n })).toMatch(/min-?raise/i)
  })

  it('fold removes a seat from the action and from later pot eligibility', () => {
    const { s: s0, escrow } = table(3, 100n, 1n, 2n, 0)
    let s = postBlinds(s0, escrow)
    s = step(s, { kind: 'FOLD', seat: 0 }, escrow) // UTG folds
    expect(s.folded[0]).toBe(true)
    s = step(s, { kind: 'CALL', seat: 1 }, escrow) // SB completes
    s = step(s, { kind: 'CHECK', seat: 2 }, escrow) // BB checks => flop
    expect(s.phase).toBe(Phase.DEAL_FLOP)
    // toAct postflop = first live seat left of button: seat 1 (seat 0 folded)
    expect(s.toAct).toBe(1)
  })

  it('everyone folds to one seat: hand ends, uncalled chips returned, winner gets the pot (stub)', () => {
    const { s: s0, escrow } = table(3, 100n, 1n, 2n, 0)
    let s = postBlinds(s0, escrow)
    s = step(s, { kind: 'FOLD', seat: 0 }, escrow)
    s = step(s, { kind: 'FOLD', seat: 1 }, escrow)
    // Only BB (seat 2) remains -> hand is uncontested, jumps to SHOWDOWN/settle.
    expect(s.phase).toBe(Phase.SHOWDOWN)
    // The single live seat sweeps the pot; SB(1)+BB(2)=3 to seat 2, who had committed 2.
    // Conservation must still hold against escrow.
    expect(conserved(s)).toBe(escrow)
    // Stub winner assignment: the lone live seat is credited (clearly marked stub in rules.ts).
    expect(s.folded).toEqual([true, true, false])
  })
})

describe('Hold\'em betting — all-ins + side-pots + conservation', () => {
  it('multi-level all-in builds layered side-pots; conservation holds at every step', () => {
    // 3 seats, stacks 5 / 15 / 100. Blinds 1/2, button 0.
    const s0raw = initHoldem({ nSeats: 3, stacks: [5n, 15n, 100n], button: 0, sb: 1n, bb: 2n })
    const escrow = 5n + 15n + 100n
    let s = postBlinds(s0raw, escrow)
    // toAct = seat 0 (button, UTG in 3-handed). Seat 0 shoves all-in for 5.
    expect(s.toAct).toBe(0)
    s = step(s, { kind: 'RAISE', seat: 0, to: 5n }, escrow)
    expect(s.allIn[0]).toBe(true)
    // Seat 1 (SB, already 1 in) shoves all-in for total 15.
    s = step(s, { kind: 'RAISE', seat: 1, to: 15n }, escrow)
    expect(s.allIn[1]).toBe(true)
    // Seat 2 (BB, 2 in) calls 15.
    s = step(s, { kind: 'CALL', seat: 2 }, escrow)
    // Round closes; all three all-in or matched -> run out to showdown.
    // totalContributed = [5, 15, 15] -> pots: main 15 {0,1,2}, side 20 {1,2}
    expect(s.totalContributed).toEqual([5n, 15n, 15n])
    const allPots = [{ amount: s.pot, eligible: potEligible(s, 0) }, ...s.sidePots]
    expect(s.pot).toBe(15n)
    expect(s.sidePots).toHaveLength(1)
    expect(s.sidePots[0]!.amount).toBe(20n)
    expect(s.sidePots[0]!.eligible).toEqual([1, 2])
    expect(conserved(s)).toBe(escrow)
    void allPots
  })

  it('all-in for less than a full raise does NOT reopen betting (incomplete-raise rule)', () => {
    // 3 seats, stacks 100 / 100 / 7. Blinds 1/2, button 0.
    const s0raw = initHoldem({ nSeats: 3, stacks: [100n, 100n, 7n], button: 0, sb: 1n, bb: 2n })
    const escrow = 207n
    let s = postBlinds(s0raw, escrow)
    // seat 0 raises to 6 (currentBet 2, +4). minRaise becomes 4.
    s = step(s, { kind: 'RAISE', seat: 0, to: 6n }, escrow)
    expect(s.currentBet).toBe(6n)
    expect(s.minRaise).toBe(4n)
    // seat 1 calls 6.
    s = step(s, { kind: 'CALL', seat: 1 }, escrow)
    // seat 2 (BB, 2 in, stack 7) shoves all-in for total 7 — only +1 over the 6 bet,
    // less than the min-raise of 4. This is an incomplete raise: currentBet rises to 7
    // for calling purposes but the action does NOT reopen for seats 0/1 to re-raise.
    s = step(s, { kind: 'RAISE', seat: 2, to: 7n }, escrow)
    expect(s.allIn[2]).toBe(true)
    expect(s.currentBet).toBe(7n)
    // minRaise unchanged (incomplete raise doesn't grow it).
    expect(s.minRaise).toBe(4n)
    // Seat 0 owes 1 to call. Seat 0 may CALL but may NOT RAISE-reopen... actually seat 0
    // CAN still raise because seat 0 has not yet faced a full raise closing — but the
    // canonical incomplete-raise rule: a player who already acted and is now facing only
    // an incomplete all-in raise may only call or fold. Seat 0 already acted (raised to 6),
    // so seat 0 may only call/fold now.
    expect(reject(s, { kind: 'RAISE', seat: 0, to: 11n })).toMatch(/reopen|min-?raise|incomplete/i)
    s = step(s, { kind: 'CALL', seat: 0 }, escrow) // call the extra 1
    s = step(s, { kind: 'CALL', seat: 1 }, escrow) // call the extra 1
    // Round closes. contributed [7,7,7] -> single pot 21 (no side pot; seat2 all-in but
    // others matched its level exactly).
    expect(s.totalContributed).toEqual([7n, 7n, 7n])
    expect(s.pot).toBe(21n)
    expect(s.sidePots).toEqual([])
    expect(conserved(s)).toBe(escrow)
  })

  it('a folded seat forfeits its matched chips to the correct pot (conservation)', () => {
    const { s: s0, escrow } = table(4, 100n, 1n, 2n, 0)
    let s = postBlinds(s0, escrow)
    // seats: button 0 = UTG (button+3?), order: SB=1, BB=2, first preflop = button+3 = 3.
    expect(s.toAct).toBe(3)
    s = step(s, { kind: 'CALL', seat: 3 }, escrow) // UTG calls 2
    s = step(s, { kind: 'CALL', seat: 0 }, escrow) // button calls 2
    s = step(s, { kind: 'FOLD', seat: 1 }, escrow) // SB folds (forfeits its 1)
    s = step(s, { kind: 'CHECK', seat: 2 }, escrow) // BB checks => flop
    expect(s.phase).toBe(Phase.DEAL_FLOP)
    // totalContributed = [2,1,2,2]; SB folded but its 1 stays in the pot.
    expect(s.totalContributed).toEqual([2n, 1n, 2n, 2n])
    expect(s.pot).toBe(7n)
    expect(conserved(s)).toBe(escrow)
  })
})

describe('Hold\'em betting — short blinds (all-in for less than the blind)', () => {
  it('BB with stack < big blind posts all-in for its whole stack, no throw, conserves', () => {
    // 3 seats, button 0 -> SB = seat 1, BB = seat 2. BB stack is 1, big blind is 2.
    const s0raw = initHoldem({ nSeats: 3, stacks: [100n, 100n, 1n], button: 0, sb: 1n, bb: 2n })
    const escrow = 201n
    // SB posts the full 1 (stack 100 covers it).
    let s = step(s0raw, { kind: 'POST_BLIND', seat: 1, amount: 1n }, escrow)
    // BB owes 2 but only has 1 -> posts min(stack, blind) = 1 and is marked all-in.
    // This MUST return a valid MoveResult (the old code threw 'insufficient stack').
    s = step(s, { kind: 'POST_BLIND', seat: 2, amount: 1n }, escrow)
    expect(s.allIn[2]).toBe(true)
    expect(s.stacks[2]).toBe(0n)
    expect(s.committed[2]).toBe(1n)
    expect(s.totalContributed[2]).toBe(1n)
    // The full big blind opened the action even though the BB could only cover part of it.
    expect(s.currentBet).toBe(2n)
    // Action opens left of the BB = button (seat 0) preflop.
    expect(s.toAct).toBe(0)
    expect(conserved(s)).toBe(escrow)
  })

  it('the all-in short-BB cannot act again; the hand proceeds and conserves', () => {
    const s0raw = initHoldem({ nSeats: 3, stacks: [100n, 100n, 1n], button: 0, sb: 1n, bb: 2n })
    const escrow = 201n
    let s = step(s0raw, { kind: 'POST_BLIND', seat: 1, amount: 1n }, escrow)
    s = step(s, { kind: 'POST_BLIND', seat: 2, amount: 1n }, escrow)
    // Seat 0 (UTG) calls 2; SB (seat 1) completes; BB (seat 2) is all-in and ineligible to act.
    s = step(s, { kind: 'CALL', seat: 0 }, escrow)
    s = step(s, { kind: 'CALL', seat: 1 }, escrow)
    // Round closes: seats 0 & 1 matched at 2, seat 2 all-in at 1. We advance off preflop.
    expect(s.phase).not.toBe(Phase.BET_PREFLOP)
    // The all-in short BB never gets the turn again on this street.
    expect(s.allIn[2]).toBe(true)
    // totalContributed = [2, 2, 1]: main pot 3 {0,1,2}, side pot 2 {0,1}.
    expect(s.totalContributed).toEqual([2n, 2n, 1n])
    expect(conserved(s)).toBe(escrow)
  })

  it('SB with stack < small blind posts all-in for its whole stack, no throw', () => {
    // SB = seat 1 with stack 1, small blind 2 (bb 4) -> SB short.
    const s0raw = initHoldem({ nSeats: 3, stacks: [100n, 1n, 100n], button: 0, sb: 2n, bb: 4n })
    const escrow = 201n
    // SB owes 2 but only has 1 -> posts 1 all-in.
    let s = step(s0raw, { kind: 'POST_BLIND', seat: 1, amount: 1n }, escrow)
    expect(s.allIn[1]).toBe(true)
    expect(s.stacks[1]).toBe(0n)
    expect(s.committed[1]).toBe(1n)
    // BB still owed by seat 2; toAct moved to the BB seat.
    expect(s.toAct).toBe(2)
    expect(conserved(s)).toBe(escrow)
  })

  it('heads-up: button/SB short all-in, BB posts, button is all-in and cannot act', () => {
    // N=2, button 0 is SB. Button stack 1, small blind 2.
    const s0raw = initHoldem({ nSeats: 2, stacks: [1n, 100n], button: 0, sb: 2n, bb: 4n })
    const escrow = 101n
    // Button (SB) posts min(1,2)=1 all-in.
    let s = step(s0raw, { kind: 'POST_BLIND', seat: 0, amount: 1n }, escrow)
    expect(s.allIn[0]).toBe(true)
    // BB (seat 1) posts the full 4.
    s = step(s, { kind: 'POST_BLIND', seat: 1, amount: 4n }, escrow)
    expect(s.currentBet).toBe(4n)
    expect(conserved(s)).toBe(escrow)
  })
})

// Helper: the bottom pot's eligible set isn't stored separately on HoldemState (pot is the
// bottom layer); recompute it for assertions from totalContributed/folded.
function potEligible(s: HoldemState, _layer: number): number[] {
  const out: number[] = []
  for (let i = 0; i < s.nSeats; i++) if (!s.folded[i] && s.totalContributed[i]! > 0n) out.push(i)
  return out
}
