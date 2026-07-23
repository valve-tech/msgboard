import { buildSidePots, splitPot, type SidePotTS } from './sidePots'
import { evaluate7 } from './handEval'

/// Game phases. SETUP→SHUFFLE→DEAL_HOLE are deal-layer (Task 3); the four BET_* streets are
/// the betting rounds; SHOWDOWN/SETTLED are settled by the channel (showdown winner is Task 6/7
/// — STUBBED here). DEAL_* phases are entered when a betting round closes and wait for the
/// session to attest the board reveal completed (a DEAL_DONE move advances to the next BET_*).
export enum Phase {
  SETUP = 0,
  SHUFFLE = 1,
  DEAL_HOLE = 2,
  BET_PREFLOP = 3,
  DEAL_FLOP = 4,
  BET_FLOP = 5,
  DEAL_TURN = 6,
  BET_TURN = 7,
  DEAL_RIVER = 8,
  BET_RIVER = 9,
  SHOWDOWN = 10,
  SETTLED = 11,
}

/// The betting streets, in order, paired with the deal phase that precedes each.
const STREETS = [Phase.BET_PREFLOP, Phase.BET_FLOP, Phase.BET_TURN, Phase.BET_RIVER] as const

export interface HoldemState {
  phase: Phase
  nSeats: number
  button: number
  toAct: number // seat index whose action is owed (only meaningful in a BET_* phase)
  stacks: bigint[] // remaining behind, per seat
  committed: bigint[] // contributions THIS street, per seat
  totalContributed: bigint[] // whole-hand contributions, per seat (drives side-pots)
  folded: boolean[]
  allIn: boolean[]
  currentBet: bigint // highest `committed` this street
  minRaise: bigint // minimum legal raise INCREMENT for the next raise
  lastAggressor: number // seat that made the last full bet/raise this street (-1 = none)
  // Seats that have acted since the last full bet/raise this street (used to close the round
  // and to enforce the incomplete-raise rule). Reset on a full raise.
  actedSinceAggression: boolean[]
  pot: bigint // bottom (main) pot
  sidePots: SidePotTS[] // higher all-in layers
  smallBlind: bigint
  bigBlind: bigint
  rakeBps: number
  rakeCap: bigint
  /// Winner of an uncontested hand (everyone folded to one seat). Set by `finishHand` when the
  /// hand collapses to a single live seat; -1 for a true multiway showdown (resolved by the
  /// SHOWDOWN move / hand evaluator). Distinct from the showdown payout: the uncontested winner
  /// is swept the whole pot during betting; the SHOWDOWN move then merely applies rake + SETTLES.
  stubWinner: number
  /// Rake taken at settlement (Task 7). 0 until the SHOWDOWN move runs. Mirrors the channel's
  /// ChannelStateN.rakeAccrued — included in conservation: Σ stacks + rakeAccrued == Σ escrow
  /// once SETTLED (pot/sidePots both 0).
  rakeAccrued: bigint
}

export type Move =
  | { kind: 'POST_BLIND'; seat: number; amount: bigint }
  | { kind: 'CHECK' | 'CALL' | 'FOLD'; seat: number }
  | { kind: 'BET' | 'RAISE'; seat: number; to: bigint } // `to` = total this-street commitment
  | { kind: 'DEAL_DONE'; phase: Phase } // session attests the reveal group completed
  // Showdown reveal (Task 7): the session supplies every seat's 2 unmasked hole indices
  // (`holes[seat]`) and the 5 community indices (`board`). The rules resolve each pot among
  // its eligible seats, apply rake, and SETTLE. Folded seats' holes are ignored (any value).
  | { kind: 'SHOWDOWN'; holes: number[][]; board: number[] }

export type MoveResult = { state: HoldemState } | { error: string }

export interface InitArgs {
  nSeats: number
  stacks: bigint[]
  button: number
  sb: bigint
  bb: bigint
  rakeBps?: number
  rakeCap?: bigint
}

/// Build the opening BET_PREFLOP state with blinds NOT yet posted. `toAct` points at the seat
/// that owes the small blind. Heads-up (N=2): the button is the small blind.
export function initHoldem(a: InitArgs): HoldemState {
  if (a.nSeats < 2) throw new Error('holdem: need >= 2 seats')
  if (a.stacks.length !== a.nSeats) throw new Error('holdem: stacks length mismatch')
  const sbSeat = a.nSeats === 2 ? a.button : (a.button + 1) % a.nSeats
  return {
    phase: Phase.BET_PREFLOP,
    nSeats: a.nSeats,
    button: a.button,
    toAct: sbSeat,
    stacks: [...a.stacks],
    committed: Array(a.nSeats).fill(0n),
    totalContributed: Array(a.nSeats).fill(0n),
    folded: Array(a.nSeats).fill(false),
    allIn: Array(a.nSeats).fill(false),
    currentBet: 0n,
    minRaise: a.bb, // first legal raise increment is one big blind
    lastAggressor: -1,
    actedSinceAggression: Array(a.nSeats).fill(false),
    pot: 0n,
    sidePots: [],
    smallBlind: a.sb,
    bigBlind: a.bb,
    rakeBps: a.rakeBps ?? 0,
    rakeCap: a.rakeCap ?? 0n,
    stubWinner: -1,
    rakeAccrued: 0n,
  }
}

/// Σ stacks + pot + Σ sidePots.amount (+ rake, which is 0 during betting). The channel's
/// conservation target = total escrow. Asserted by tests after every accepted transition.
export function conserved(s: HoldemState): bigint {
  let sum = s.pot + s.rakeAccrued
  for (const b of s.stacks) sum += b
  for (const sp of s.sidePots) sum += sp.amount
  return sum
}

// ----- internal helpers (pure, operate on a fresh clone) -----

function clone(s: HoldemState): HoldemState {
  return {
    ...s,
    stacks: [...s.stacks],
    committed: [...s.committed],
    totalContributed: [...s.totalContributed],
    folded: [...s.folded],
    allIn: [...s.allIn],
    actedSinceAggression: [...s.actedSinceAggression],
    sidePots: s.sidePots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
  }
}

const liveCount = (s: HoldemState) => s.folded.filter((f) => !f).length

/// Seats still able to act voluntarily this street (not folded, not all-in).
function actableCount(s: HoldemState): number {
  let n = 0
  for (let i = 0; i < s.nSeats; i++) if (!s.folded[i] && !s.allIn[i]) n++
  return n
}

/// Next seat (clockwise) that may act this street, starting after `from`. Returns -1 if none.
function nextToAct(s: HoldemState, from: number): number {
  for (let k = 1; k <= s.nSeats; k++) {
    const seat = (from + k) % s.nSeats
    if (!s.folded[seat] && !s.allIn[seat]) return seat
  }
  return -1
}

/// First live seat left of the button (button+1, …) — postflop first-to-act.
function firstLiveLeftOfButton(s: HoldemState): number {
  for (let k = 1; k <= s.nSeats; k++) {
    const seat = (s.button + k) % s.nSeats
    if (!s.folded[seat] && !s.allIn[seat]) return seat
  }
  return -1
}

/// Recompute pot (bottom layer) + sidePots (higher layers) from totalContributed + folded.
function recomputePots(s: HoldemState): void {
  const layers = buildSidePots(s.totalContributed, s.folded)
  if (layers.length === 0) {
    s.pot = 0n
    s.sidePots = []
  } else {
    s.pot = layers[0]!.amount
    s.sidePots = layers.slice(1)
  }
}

/// Has the betting round closed? Closed when no seat may still act, OR every actable seat has
/// matched currentBet AND has acted since the last aggression (action returned to the
/// aggressor / closed the orbit).
function roundClosed(s: HoldemState): boolean {
  if (liveCount(s) <= 1) return true
  if (actableCount(s) === 0) return true
  for (let i = 0; i < s.nSeats; i++) {
    if (s.folded[i] || s.allIn[i]) continue
    if (s.committed[i] !== s.currentBet) return false
    if (!s.actedSinceAggression[i]) return false
  }
  return true
}

/// Advance past a closed betting round: return any uncalled top bet, fold contributions into
/// the layered pots, and either move to the next DEAL_* phase or to SHOWDOWN.
function closeStreet(s: HoldemState): void {
  returnUncalled(s)
  recomputePots(s)

  // Hand over (only one live seat, or no one can act anymore -> run it out): go to SHOWDOWN.
  if (liveCount(s) <= 1) {
    finishHand(s)
    return
  }
  if (actableCount(s) <= 1 && allMatchedOrAllIn(s)) {
    // Betting cannot continue (≤1 seat can voluntarily act); the remaining streets are
    // dealt with no further betting, then showdown. We still pass through the DEAL_* phases
    // for the session to reveal the board, but no BET_* will accept actions.
  }

  // Reset for the next street.
  for (let i = 0; i < s.nSeats; i++) s.committed[i] = 0n
  s.currentBet = 0n
  s.minRaise = s.bigBlind
  s.lastAggressor = -1
  s.actedSinceAggression = Array(s.nSeats).fill(false)

  const idx = STREETS.indexOf(s.phase as (typeof STREETS)[number])
  if (idx === STREETS.length - 1) {
    // River betting closed -> showdown.
    finishHand(s)
    return
  }
  // Enter the DEAL_* phase between this street and the next (DEAL_FLOP/TURN/RIVER).
  s.phase = (s.phase as number) + 1 // BET_PREFLOP(3)->DEAL_FLOP(4), etc.
  // toAct will be set when the next BET_* opens (after DEAL_DONE).
  s.toAct = firstLiveLeftOfButton(s)
}

function allMatchedOrAllIn(s: HoldemState): boolean {
  for (let i = 0; i < s.nSeats; i++) {
    if (s.folded[i] || s.allIn[i]) continue
    if (s.committed[i] !== s.currentBet) return false
  }
  return true
}

/// Return the uncalled portion of the top bet this street: if exactly one seat committed more
/// than the second-highest committed, the excess is uncalled and refunded to its stack (its
/// totalContributed shrinks accordingly). Standard rule — an unmatched over-bet is never won.
function returnUncalled(s: HoldemState): void {
  // highest and second-highest committed this street.
  let hi = -1n
  let hiSeat = -1
  let second = 0n
  for (let i = 0; i < s.nSeats; i++) {
    const c = s.committed[i]!
    if (c > hi) {
      second = hi < 0n ? 0n : hi
      hi = c
      hiSeat = i
    } else if (c > second) {
      second = c
    }
  }
  if (hiSeat < 0 || hi <= 0n) return
  const excess = hi - second
  if (excess > 0n) {
    s.committed[hiSeat] = second
    s.stacks[hiSeat] = s.stacks[hiSeat]! + excess
    s.totalContributed[hiSeat] = s.totalContributed[hiSeat]! - excess
  }
}

/// Reach SHOWDOWN, returning uncalled chips and computing the final layered pots. The actual
/// winner(s) + payout is Task 6/7 — STUBBED: for an uncontested hand the lone live seat is
/// recorded in `stubWinner` and swept the whole pot so the channel still conserves; for a true
/// multiway showdown the winner is left for the evaluator and pots remain unswept (stubWinner=-1).
function finishHand(s: HoldemState): void {
  returnUncalled(s)
  recomputePots(s)
  s.phase = Phase.SHOWDOWN
  s.toAct = -1
  const live = liveSeats(s)
  if (live.length === 1) {
    // Uncontested: sweep every pot to the lone live seat (it is eligible to all of them).
    const seat = live[0]!
    let total = s.pot
    for (const sp of s.sidePots) total += sp.amount
    s.stacks[seat] = s.stacks[seat]! + total
    s.pot = 0n
    s.sidePots = []
    s.stubWinner = seat
  }
  // else: multiway showdown — winner(s) decided by the (Task 6) evaluator; pots stay put.
}

function liveSeats(s: HoldemState): number[] {
  const out: number[] = []
  for (let i = 0; i < s.nSeats; i++) if (!s.folded[i]) out.push(i)
  return out
}

// ----- showdown settlement (Task 7) -----

/// One pot to award: its amount, the eligible (non-folded) seats contesting it, and whether
/// it is rakeable (≥2 eligible seats — a single-eligible pot is an uncalled return, no rake).
interface PotToAward {
  amount: bigint
  eligible: number[]
}

/// The ordered pots a showdown must award: main pot first, then each side pot (lowest layer
/// to highest). Eligibility is intersected with non-folded seats. Mirrors the on-chain order.
function potsToAward(s: HoldemState): PotToAward[] {
  const pots: PotToAward[] = []
  pots.push({ amount: s.pot, eligible: eligibleOf(s, allSeatsMask(s.nSeats)) })
  for (const sp of s.sidePots) pots.push({ amount: sp.amount, eligible: eligibleOf(s, maskOf(sp.eligible)) })
  return pots
}

function allSeatsMask(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i)
  return out
}
function maskOf(eligible: number[]): number[] {
  return [...eligible]
}
/// Intersect a candidate eligible set with the non-folded seats (an eligible seat that folded
/// before showdown can never win — its chips stay in the pot for the live contestants).
function eligibleOf(s: HoldemState, candidates: number[]): number[] {
  return candidates.filter((i) => !s.folded[i])
}

/**
 * Pure showdown distribution. Given the per-pot eligibility, the per-seat 7-card hands, the
 * button (for the odd-chip rule) and rake parameters, returns the per-seat winnings vector and
 * the total rake. The normative resolution — mirrored byte-for-byte by HoldemRules.sol.
 *
 * Rake rule (rake-in-conservation, plan Decision 4): rake is taken ONLY from contested pots
 * (≥2 eligible seats); a single-eligible pot is an uncalled return and is paid back in full
 * (no rake). `rake = min(rakeCap, rakeBps · Σ rakeable-pot-amounts / 10000)`, then deducted
 * from the rakeable pots in order (main first) BEFORE each pot is split among its winners.
 *
 * Conservation: Σ winnings + rake == Σ pot amounts, exactly.
 *
 * `hands[seat]` is that seat's 7 card indices (2 hole ∪ 5 board); only consulted for seats
 * that are eligible for some pot. `score(seat)` is memoized.
 */
export function showdownPayouts(args: {
  nSeats: number
  button: number
  pots: PotToAward[]
  hands: number[][]
  rakeBps: number
  rakeCap: bigint
}): { winnings: bigint[]; rake: bigint } {
  const { nSeats, button, pots, hands, rakeBps, rakeCap } = args
  const winnings = Array(nSeats).fill(0n) as bigint[]

  // Memoized hand score per seat (only computed for seats that contest a pot).
  const scoreCache = new Map<number, bigint>()
  const scoreOf = (seat: number): bigint => {
    let v = scoreCache.get(seat)
    if (v === undefined) {
      v = evaluate7(hands[seat]!)
      scoreCache.set(seat, v)
    }
    return v
  }

  // Rake base = Σ amounts of contested pots (≥2 eligible). Single-eligible pots are uncalled
  // returns and never raked.
  let rakeBase = 0n
  for (const p of pots) if (p.eligible.length >= 2) rakeBase += p.amount
  let rake = (BigInt(rakeBps) * rakeBase) / 10000n
  if (rake > rakeCap) rake = rakeCap
  let rakeRemaining = rake

  for (const p of pots) {
    if (p.amount === 0n || p.eligible.length === 0) continue
    // Deduct the outstanding rake from this pot, but only from a contested (rakeable) pot.
    let distributable = p.amount
    if (p.eligible.length >= 2 && rakeRemaining > 0n) {
      const take = rakeRemaining < distributable ? rakeRemaining : distributable
      distributable -= take
      rakeRemaining -= take
    }
    if (distributable === 0n) continue
    // Find the max-scoring eligible seat(s).
    let best = -1n
    for (const seat of p.eligible) {
      const sc = scoreOf(seat)
      if (sc > best) best = sc
    }
    const winners = p.eligible.filter((seat) => scoreOf(seat) === best)
    for (const { seat, amount } of splitPot(distributable, winners, button, nSeats)) {
      winnings[seat] = winnings[seat]! + amount
    }
  }
  return { winnings, rake }
}

/// Resolve the SHOWDOWN move: award pots, apply rake, write final balances into `stacks`,
/// set `rakeAccrued`, zero the pots and reach SETTLED. For an already-swept uncontested hand
/// (stubWinner ≥ 0) the pots are empty; we still apply rake to the swept winnings so the
/// channel conservation (Σ stacks + rake == Σ escrow) holds with the rake field populated.
function resolveShowdown(s0: HoldemState, holes: number[][], board: number[]): MoveResult {
  const s = clone(s0)

  if (s0.stubWinner >= 0) {
    // Uncontested: `finishHand` already swept the whole pot into stubWinner's stack. Apply
    // rake on that swept amount (a contested win — the lone seat called/was called). The
    // amount won this hand = its totalContributed-minus-its-own-stake share is awkward to
    // recover; instead rake the entire collected pot for this hand. The collected pot equals
    // Σ totalContributed (uncalled already returned), so rake on that base.
    let potBase = 0n
    for (const c of s.totalContributed) potBase += c
    let rake = (BigInt(s.rakeBps) * potBase) / 10000n
    if (rake > s.rakeCap) rake = s.rakeCap
    // Deduct rake from the winner's swept stack.
    s.stacks[s0.stubWinner] = s.stacks[s0.stubWinner]! - rake
    s.rakeAccrued = rake
    s.phase = Phase.SETTLED
    s.toAct = -1
    return { state: s }
  }

  // Multiway showdown: validate inputs.
  if (!Array.isArray(board) || board.length !== 5) return err('showdown: board must be 5 cards')
  if (!Array.isArray(holes) || holes.length !== s.nSeats) return err('showdown: holes per seat required')

  const pots = potsToAward(s)
  // Build each contesting seat's 7-card hand (only the eligible/non-folded seats matter).
  const hands: number[][] = []
  for (let i = 0; i < s.nSeats; i++) {
    if (s.folded[i]) {
      hands.push([]) // never evaluated
      continue
    }
    const h = holes[i]
    if (!Array.isArray(h) || h.length !== 2) return err(`showdown: seat ${i} needs 2 hole cards`)
    hands.push([h[0]!, h[1]!, ...board])
  }

  const { winnings, rake } = showdownPayouts({
    nSeats: s.nSeats,
    button: s.button,
    pots,
    hands,
    rakeBps: s.rakeBps,
    rakeCap: s.rakeCap,
  })
  for (let i = 0; i < s.nSeats; i++) s.stacks[i] = s.stacks[i]! + winnings[i]!
  s.rakeAccrued = rake
  s.pot = 0n
  s.sidePots = []
  s.phase = Phase.SETTLED
  s.toAct = -1
  return { state: s }
}

const err = (e: string): MoveResult => ({ error: `holdem: ${e}` })

// ----- the betting transition -----

export function applyMove(s0: HoldemState, m: Move): MoveResult {
  // DEAL_DONE advances a DEAL_* phase to the BET_* street that follows it.
  if (m.kind === 'DEAL_DONE') {
    if (s0.phase !== Phase.DEAL_HOLE && s0.phase !== Phase.DEAL_FLOP &&
        s0.phase !== Phase.DEAL_TURN && s0.phase !== Phase.DEAL_RIVER)
      return err(`DEAL_DONE in phase ${s0.phase}`)
    const s = clone(s0)
    if (s.phase === Phase.DEAL_HOLE) s.phase = Phase.BET_PREFLOP
    else s.phase = (s.phase as number) + 1 // DEAL_FLOP(4)->BET_FLOP(5), etc.
    // Open the street: first to act. Preflop opens left of BB; postflop left of button.
    s.toAct = firstLiveLeftOfButton(s)
    // Run-out: if at most one seat can voluntarily act (everyone else is all-in/folded) and
    // the board state is already settled (no outstanding bet to match), there is no betting
    // on this street — close it through to the next deal phase / showdown.
    if (actableCount(s) <= 1 && allMatchedOrAllIn(s)) closeStreet(s)
    return { state: s }
  }

  // SHOWDOWN resolution: only from the SHOWDOWN phase. Distributes every pot to its best
  // eligible hand(s), applies rake, and reaches SETTLED.
  if (m.kind === 'SHOWDOWN') {
    if (s0.phase !== Phase.SHOWDOWN) return err(`SHOWDOWN in phase ${s0.phase}`)
    return resolveShowdown(s0, m.holes, m.board)
  }

  if (
    s0.phase !== Phase.BET_PREFLOP &&
    s0.phase !== Phase.BET_FLOP &&
    s0.phase !== Phase.BET_TURN &&
    s0.phase !== Phase.BET_RIVER
  )
    return err(`no betting in phase ${s0.phase}`)

  const seat = m.seat
  if (!Number.isInteger(seat) || seat < 0 || seat >= s0.nSeats) return err('seat out of range')

  // POST_BLIND is a setup move accepted only at the very start of preflop (currentBet not yet
  // at the big blind). It is owed by `toAct` in blind order.
  if (m.kind === 'POST_BLIND') {
    if (s0.phase !== Phase.BET_PREFLOP) return err('POST_BLIND outside preflop open')
    if (seat !== s0.toAct) return err('not your turn (blind order)')
    const expectSb = s0.committed.every((c) => c === 0n)
    const requiredBlind = expectSb ? s0.smallBlind : s0.bigBlind
    // Short all-in blind (standard live poker): a seat that can't cover its blind posts its
    // whole stack and is all-in. The seat must post exactly min(stack, requiredBlind).
    const expected = requiredBlind < s0.stacks[seat]! ? requiredBlind : s0.stacks[seat]!
    if (m.amount !== expected) return err(`blind must be ${expected}`)
    const s = clone(s0)
    putIn(s, seat, m.amount, /*isVoluntary*/ false) // marks all-in if it empties the stack
    if (!expectSb) {
      // Big blind posted: open the action. The action level is the FULL big blind even when
      // the BB could only cover part of it (a short BB is all-in for less; later seats still
      // owe the full blind to call).
      s.currentBet = s.bigBlind
      s.minRaise = s.bigBlind
      // first to act preflop = seat left of the BB.
      s.toAct = nextToAct(s, seat)
    } else {
      s.toAct = nextToAct(s, seat)
    }
    return { state: s }
  }

  // From here on a real betting action: must be in-turn. PRE-FLOP additionally requires both
  // blinds to be up first (the big blind opens the action by setting currentBet); post-flop
  // streets legitimately start with everyone committed 0 and currentBet 0.
  if (s0.phase === Phase.BET_PREFLOP && s0.currentBet < s0.bigBlind) return err('blinds not posted')
  if (seat !== s0.toAct) return err('not your turn')
  if (s0.folded[seat]) return err('folded seat cannot act')
  if (s0.allIn[seat]) return err('all-in seat cannot act')

  const toCall = s0.currentBet - s0.committed[seat]!

  switch (m.kind) {
    case 'FOLD': {
      const s = clone(s0)
      s.folded[seat] = true
      s.actedSinceAggression[seat] = true
      return advance(s, seat)
    }
    case 'CHECK': {
      if (toCall !== 0n) return err('cannot check facing a bet')
      const s = clone(s0)
      s.actedSinceAggression[seat] = true
      return advance(s, seat)
    }
    case 'CALL': {
      if (toCall <= 0n) return err('nothing to call (use CHECK)')
      const pay = toCall < s0.stacks[seat]! ? toCall : s0.stacks[seat]!
      const s = clone(s0)
      putIn(s, seat, pay, /*isVoluntary*/ true)
      s.actedSinceAggression[seat] = true
      return advance(s, seat)
    }
    case 'BET':
    case 'RAISE': {
      // Incomplete-raise rule: a seat that has already acted since the last FULL raise may
      // not re-raise when the only intervening aggression was an all-in for less than a full
      // raise. Such a seat owes a chip top-up but the betting is NOT reopened for it — it may
      // only CALL or FOLD. (`actedSinceAggression` is reset only by a full raise, so it being
      // set here while the seat still faces a bet means the action did not legally reopen.)
      if (s0.actedSinceAggression[seat] && s0.currentBet > s0.committed[seat]!)
        return err('cannot reopen betting on an incomplete (all-in-for-less) raise')
      const s = clone(s0)
      const target = m.to // total this-street commitment after the action
      const already = s0.committed[seat]!
      if (target <= s0.currentBet) return err('bet/raise must exceed current bet')
      const need = target - already
      if (need <= 0n) return err('raise must add chips')
      const stack = s0.stacks[seat]!
      const isAllIn = need >= stack
      const actualAdd = isAllIn ? stack : need
      const actualTarget = already + actualAdd
      // A short all-in whose *actual* (stack-capped) total does not exceed the current bet is
      // not a bet/raise — it's an all-in call for less. Reject it as a BET/RAISE (the caller
      // must CALL). Without this guard `increment` below would go negative; Solidity computes
      // it in uint256 and would underflow-revert, desyncing the two implementations.
      if (actualTarget <= s0.currentBet) return err('all-in does not exceed current bet (use CALL)')
      const increment = actualTarget - s0.currentBet
      // A non-all-in raise must meet the min-raise increment.
      if (!isAllIn && increment < s0.minRaise) return err('raise below min-raise')
      // An all-in for less than a full raise (incomplete raise) is allowed but does NOT
      // reopen the betting: it raises currentBet for calling purposes but seats that already
      // acted since the last full aggression may then only call or fold.
      const isFullRaise = increment >= s0.minRaise
      putIn(s, seat, actualAdd, /*isVoluntary*/ true)
      s.currentBet = actualTarget
      if (isFullRaise) {
        s.minRaise = increment
        s.lastAggressor = seat
        s.actedSinceAggression = Array(s.nSeats).fill(false)
      }
      s.actedSinceAggression[seat] = true
      return advance(s, seat)
    }
    default:
      return err('unknown move')
  }
}

/// Apply chips from a seat's stack into committed + totalContributed. Marks all-in if the
/// stack is emptied. `isVoluntary` is unused for accounting but documents intent.
function putIn(s: HoldemState, seat: number, amount: bigint, _isVoluntary: boolean): void {
  if (amount < 0n) throw new Error('holdem: negative put-in')
  if (amount > s.stacks[seat]!) throw new Error('holdem: insufficient stack')
  s.stacks[seat] = s.stacks[seat]! - amount
  s.committed[seat] = s.committed[seat]! + amount
  s.totalContributed[seat] = s.totalContributed[seat]! + amount
  if (s.stacks[seat] === 0n) s.allIn[seat] = true
  recomputePots(s)
}

/// After an in-turn action, either close the street or pass the turn to the next actable seat.
function advance(s: HoldemState, from: number): MoveResult {
  recomputePots(s)
  if (roundClosed(s)) {
    closeStreet(s)
    return { state: s }
  }
  const next = nextToAct(s, from)
  if (next < 0) {
    closeStreet(s)
    return { state: s }
  }
  s.toAct = next
  return { state: s }
}
