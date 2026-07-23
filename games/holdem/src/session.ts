import { keccak256, concatHex, type Hex } from 'viem'
import {
  Transcript,
  type MaskedDeckProvider,
  type WireMasked,
  type WireShuffle,
} from '@msgboard/zk-cards-core'
import { jointKey, runShuffleChain } from './deckN'
import { dealPlan, runDeal, type DealBoard } from './dealSeq'
import {
  Phase,
  initHoldem,
  applyMove,
  type HoldemState,
  type Move,
} from './rules'
import { toChannelSettleState } from './encoding'
import { ChannelN } from './channelN'
import {
  TEST_DOMAIN_N,
  type ChannelDomainN,
  type ChannelStateN,
  type StateSigner,
} from './stateSigN'

/**
 * End-to-end multi-seat hand — Track 3 Task 8.
 *
 * `runHand` wires EVERY prior task into a single full Texas Hold'em hand over the
 * (fake/in-memory) board, exercising each real module in sequence:
 *
 *   1. Deck (Task 1)    — jointKey over all seats' deck pubs + runShuffleChain (each seat
 *                         shuffles+re-encrypts in turn; attested).
 *   2. Deal (Task 3)    — runDeal posts the SHUFFLE chain (carrying the REAL per-round
 *                         WireShuffles — M1 carry-forward), then hole+flop+turn+river reveals,
 *                         each a board post; verify-then-combine on every share. Each seat
 *                         learns exactly its 2 hole cards; the 5 community cards are public;
 *                         every undealt slot stays hidden.
 *   3. Betting (Task 5) — auto-posts the blinds, then drives the four streets via each seat's
 *                         scripted actions through rules.ts applyMove; conservation is asserted
 *                         (by the channel) at every co-signed step.
 *   4. Showdown (Task 7)— at SHOWDOWN, feeds the REAL revealed holes+community into the
 *                         SHOWDOWN move → per-pot winners + rake (uncontested sweeps need no
 *                         evaluation).
 *   5. Settle bridge    — toChannelSettleState turns the SETTLED HoldemState into the N-of-N
 *                         co-signed ChannelStateN the chain's HoldemTableN.settle verifies.
 *
 * This module does NOT re-implement crypto, rules, side-pots, or the evaluator — it sequences
 * the already-proven pieces. The on-chain settle acceptance is exercised by the hardhat+viem
 * e2e test (it submits res.settleState + res.settleSigs to an anvil-deployed HoldemTableN).
 */

/** Wallet/channel signer shape — viem accounts satisfy both message + typed-data signing. */
export interface SessionSigner {
  address: Hex
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>
  signTypedData(args: any): Promise<Hex>
}

/** One seated player: deck keypair + the wallet that signs board envelopes/shuffles, and the
 *  channel key that co-signs ChannelStateN (may equal the wallet). */
export interface SessionSeat {
  secret: Hex
  pub: Hex
  addr: Hex
  signer: SessionSigner
  channel: StateSigner
}

/** A single street action token. `'RAISE:<n>'`/`'BET:<n>'` carry the total this-street target;
 *  `'ALLIN'` shoves the seat's whole remaining stack. */
export type ActionToken = 'CHECK' | 'CALL' | 'FOLD' | 'ALLIN' | `BET:${string}` | `RAISE:${string}`

/** Per-seat scripted actions, one queue per street (consumed in turn order). */
export interface SeatScript {
  preflop?: ActionToken[]
  flop?: ActionToken[]
  turn?: ActionToken[]
  river?: ActionToken[]
}

export interface RunHandArgs {
  provider: MaskedDeckProvider
  seats: SessionSeat[]
  tableId: Hex
  /** Uniform per-seat buy-in. Ignored for any seat overridden by `buyIns`. */
  buyIn: bigint
  /** Per-seat buy-in override (length === seats.length). Use for uneven stacks (e.g. a
   *  short-stacked seat that goes all-in for less, forming a real multi-level side pot).
   *  When omitted every seat buys in for `buyIn`. */
  buyIns?: bigint[]
  button: number
  sb: bigint
  bb: bigint
  rakeBps?: number
  rakeCap?: bigint
  scripts: SeatScript[]
  /** EIP-712 domain for the channel co-sign; defaults to the test domain. */
  domain?: ChannelDomainN
}

/** A fully- or partially-co-signed ChannelStateN snapshot captured at one nonce. */
export interface CoSignedSnapshot {
  state: ChannelStateN
  sigs: (Hex | undefined)[]
}

export interface HandResult {
  /** the final SETTLED HoldemState (game layer) */
  final: HoldemState
  /** the channel settle state submitted on-chain (balances vector + rake, pot/sidePots empty) */
  settleState: ChannelStateN
  /** the N-of-N signatures over settleState (index i = seat i's channel sig) */
  settleSigs: (Hex | undefined)[]
  /** every co-signed ChannelStateN in nonce order (genesis → … → SETTLED) */
  coSigned: CoSignedSnapshot[]
  /** the HoldemState preimage of each co-signed snapshot's `gameStateHash`, aligned 1:1 with
   *  `coSigned` (genesis/post-shuffle states use the SETUP state). This is what the on-chain
   *  dispute path needs: `encodeGameState(gameStates[i])` is the `gameState` preimage whose
   *  keccak == `coSigned[i].state.gameStateHash`, and `whoseTurn` over it names the owing seat. */
  gameStates: HoldemState[]
  /** per-seat hole cards (each seat learned exactly its 2) */
  holeCards: Record<number, number[]>
  /** the 5 community cards */
  community: number[]
  /** the board transcript (shuffle + deal + betting posts) */
  transcript: Transcript
  /** the joint deck key + the masked initial deck (for shuffle-chain verification) */
  agg: Hex
  initial: WireMasked[]
  /** keccak commitment of the post-shuffle deck */
  deckCommitment: Hex
}

const STREET_KEYS = ['preflop', 'flop', 'turn', 'river'] as const
type StreetKey = (typeof STREET_KEYS)[number]

/** Which script street a BET_* phase reads from. */
function streetKeyFor(phase: Phase): StreetKey {
  switch (phase) {
    case Phase.BET_PREFLOP:
      return 'preflop'
    case Phase.BET_FLOP:
      return 'flop'
    case Phase.BET_TURN:
      return 'turn'
    case Phase.BET_RIVER:
      return 'river'
    default:
      throw new Error(`session: streetKeyFor on non-betting phase ${phase}`)
  }
}

/** keccak over the flattened masked-deck ciphertext — mirrors dealSeq.deckCommitment. */
function commit(deck: WireMasked[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

/** Translate a script token into a concrete Move for the seat that is `toAct`. */
function tokenToMove(s: HoldemState, seat: number, tok: ActionToken): Move {
  if (tok === 'CHECK' || tok === 'CALL' || tok === 'FOLD') return { kind: tok, seat }
  if (tok === 'ALLIN') {
    // Shove: total this-street target = already-committed + whole remaining stack. If that does
    // not exceed currentBet it is an all-in CALL (rules reject ALLIN-as-RAISE there), so emit CALL.
    const target = s.committed[seat]! + s.stacks[seat]!
    if (target <= s.currentBet) return { kind: 'CALL', seat }
    return { kind: 'RAISE', seat, to: target }
  }
  const [kind, amt] = tok.split(':') as ['BET' | 'RAISE', string]
  return { kind, seat, to: BigInt(amt) }
}

/**
 * Run one complete N-seat Hold'em hand. Returns the SETTLED game state, the on-chain settle
 * state + N-of-N signatures, the full co-signed-state history, and the revealed cards.
 */
export async function runHand(args: RunHandArgs): Promise<HandResult> {
  const { provider, seats, tableId, buyIn, button, sb, bb } = args
  const n = seats.length
  if (args.scripts.length !== n) throw new Error('session: one script per seat required')
  if (args.buyIns && args.buyIns.length !== n)
    throw new Error('session: buyIns length must equal seat count')
  const stacks0 = args.buyIns ? [...args.buyIns] : seats.map(() => buyIn)
  const domain = args.domain ?? TEST_DOMAIN_N
  const escrow = stacks0.reduce((a, b) => a + b, 0n)
  const rakeBps = args.rakeBps ?? 0
  const rakeCap = args.rakeCap ?? 0n

  // ── 1) Deck: joint key + shuffle chain (Task 1) ──────────────────────────────
  const agg = jointKey(provider, seats.map((s) => s.pub))
  const { initial, finalDeck, rounds } = await runShuffleChain(provider, agg, seats)
  const deckCommitment = commit(finalDeck)

  // ── 2) Deal over the board (Task 3) — real WireShuffles on the SHUFFLE posts ──
  const board: DealBoard & { posts: number } = (() => {
    const transcript = new Transcript(tableId)
    return {
      transcript,
      stamp() {
        /* fake board: the live board grinds ~1-2s PoW here; tests just record the post */
      },
      get posts() {
        return transcript.entries.length
      },
    }
  })()

  const plan = dealPlan(n)
  const deal = await runDeal({
    provider,
    seats,
    agg,
    tableId,
    deck: finalDeck,
    rounds, // M1: post the REAL per-round shuffles
    plan,
    board,
    verifyAllShares: true,
  })

  // ── channel: one ChannelN per seat; genesis co-sign at nonce 0 ───────────────
  const seatKeys = seats.map((s) => s.channel.address)
  const channels = seats.map(
    (s, seat) =>
      new ChannelN({ domain, tableId, me: s.channel, seat, seatKeys, escrow }),
  )
  const coSigned: CoSignedSnapshot[] = []
  const gameStates: HoldemState[] = []

  const ZERO32 = ('0x' + '00'.repeat(32)) as Hex
  let nonce = 0n
  // Pre-blinds SETUP-equivalent game (its preimage backs the genesis snapshot slot; the genesis
  // co-signed state uses a ZERO gameStateHash, so this preimage is informational only).
  let game = initHoldem({ nSeats: n, stacks: stacks0, button, sb, bb, rakeBps, rakeCap })
  // Genesis: balances = each seat's buy-in, pot 0.
  await coSignState(channels, 0, {
    tableId,
    nonce,
    balances: [...stacks0],
    pot: 0n,
    sidePots: [],
    rakeAccrued: 0n,
    deckCommitment,
    phase: Phase.SETUP,
    gameStateHash: ZERO32,
  })
  coSigned.push(snapshot(channels[0]!))
  gameStates.push(game)

  // ── 3) Betting (Task 5) ──────────────────────────────────────────────────────
  // Auto-post blinds in blind order (the seat that is `toAct` owes the next blind).
  game = mustApply(game, { kind: 'POST_BLIND', seat: game.toAct, amount: blindAmount(game, true) })
  game = mustApply(game, { kind: 'POST_BLIND', seat: game.toAct, amount: blindAmount(game, false) })
  nonce = await syncGame(channels, coSigned, gameStates, game, ++nonce, tableId, deckCommitment)

  // Per-seat per-street action cursors.
  const cursors: Record<StreetKey, number[]> = {
    preflop: seats.map(() => 0),
    flop: seats.map(() => 0),
    turn: seats.map(() => 0),
    river: seats.map(() => 0),
  }

  // Drive until SHOWDOWN: in a BET_* phase the `toAct` seat consumes its next scripted action;
  // a DEAL_* phase advances via DEAL_DONE (the board reveal already happened up-front in the deal).
  let guard = 0
  while (game.phase !== Phase.SHOWDOWN && game.phase !== Phase.SETTLED) {
    if (++guard > 10_000) throw new Error('session: betting did not terminate')
    if (isBetPhase(game.phase)) {
      const seat = game.toAct
      if (seat < 0) throw new Error(`session: BET phase ${game.phase} with no toAct`)
      const key = streetKeyFor(game.phase)
      const idx = cursors[key][seat]!
      const queue = args.scripts[seat]![key] ?? []
      if (idx >= queue.length)
        throw new Error(`session: seat ${seat} script exhausted on ${key} (phase ${game.phase})`)
      cursors[key][seat] = idx + 1
      game = mustApply(game, tokenToMove(game, seat, queue[idx]!))
      nonce = await syncGame(channels, coSigned, gameStates, game, ++nonce, tableId, deckCommitment)
    } else if (isDealPhase(game.phase)) {
      // Board reveal already done in runDeal; attest the deal completed for this group.
      game = mustApply(game, { kind: 'DEAL_DONE', phase: game.phase })
      nonce = await syncGame(channels, coSigned, gameStates, game, ++nonce, tableId, deckCommitment)
    } else {
      throw new Error(`session: unexpected phase ${game.phase} during betting loop`)
    }
  }

  // ── 4) Showdown (Task 7) ─────────────────────────────────────────────────────
  // Feed the REAL revealed holes (each seat's 2) + the 5 community cards. Folded seats' holes
  // are ignored by the resolver but must be present (any 2 indices); use the real reveal anyway.
  const holes: number[][] = []
  for (let s = 0; s < n; s++) holes.push([...(deal.holeCards[s] ?? [0, 1])])
  const board5 = [...deal.community]
  game = mustApply(game, { kind: 'SHOWDOWN', holes, board: board5 })
  if (game.phase !== Phase.SETTLED) throw new Error('session: SHOWDOWN did not reach SETTLED')

  // ── 5) Settle bridge: SETTLED HoldemState → on-chain ChannelStateN ───────────
  // The SETTLED game has pot/sidePots zeroed and the rake in rakeAccrued — so the channel
  // settle state IS this co-signed state. Co-sign it once at the next nonce; that N-of-N state
  // is exactly what HoldemTableN.settle verifies.
  nonce += 1n
  const settleState = toChannelSettleState(game, { tableId, nonce, deckCommitment })
  const settleSigs = await coSignState(channels, 0, settleState)
  coSigned.push({ state: settleState, sigs: [...settleSigs] })
  gameStates.push(game)

  return {
    final: game,
    settleState,
    settleSigs,
    coSigned,
    gameStates,
    holeCards: deal.holeCards,
    community: deal.community,
    transcript: board.transcript,
    agg,
    initial,
    deckCommitment,
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isBetPhase(p: Phase): boolean {
  return p === Phase.BET_PREFLOP || p === Phase.BET_FLOP || p === Phase.BET_TURN || p === Phase.BET_RIVER
}
function isDealPhase(p: Phase): boolean {
  return p === Phase.DEAL_HOLE || p === Phase.DEAL_FLOP || p === Phase.DEAL_TURN || p === Phase.DEAL_RIVER
}

/** The blind the current `toAct` seat owes: SB if no one has committed yet, else BB — capped at
 *  the seat's stack (short all-in blind, mirroring rules.ts). */
function blindAmount(s: HoldemState, _wantSb: boolean): bigint {
  const isSb = s.committed.every((c) => c === 0n)
  const required = isSb ? s.smallBlind : s.bigBlind
  const stack = s.stacks[s.toAct]!
  return required < stack ? required : stack
}

function mustApply(s: HoldemState, m: Move): HoldemState {
  const r = applyMove(s, m)
  if ('error' in r) throw new Error(`session: move ${m.kind} rejected — ${r.error}`)
  return r.state
}

/** Bridge the live HoldemState into a ChannelStateN and N-of-N co-sign it at `nonce`. */
async function syncGame(
  channels: ChannelN[],
  log: CoSignedSnapshot[],
  gameLog: HoldemState[],
  game: HoldemState,
  nonce: bigint,
  tableId: Hex,
  deckCommitment: Hex,
): Promise<bigint> {
  // toChannelSettleState maps every field (balances = per-seat stacks; live chips live in
  // pot+sidePots via eligibleToMask; rakeAccrued carries the rake) and the gameStateHash, and
  // never asserts pot/sidePots empty — so it is the correct bridge for mid-hand snapshots too.
  // Conservation (Σ balances + pot + Σ sidePots + rake == escrow) holds by the rules layer.
  const state = toChannelSettleState(game, { tableId, nonce, deckCommitment })
  const sigs = await coSignState(channels, 0, state)
  log.push({ state, sigs: [...sigs] })
  gameLog.push(game)
  return nonce
}

/** Drive a full N-of-N co-sign of `state` (proposer = `proposer`); returns the N signatures. */
async function coSignState(
  channels: ChannelN[],
  proposer: number,
  state: ChannelStateN,
): Promise<(Hex | undefined)[]> {
  let partial = await channels[proposer]!.propose(state)
  for (let i = 0; i < channels.length; i++) {
    if (i === proposer) continue
    partial = await channels[i]!.countersign(partial)
  }
  await channels[proposer]!.finalize(partial)
  for (let i = 0; i < channels.length; i++) {
    if (i === proposer) continue
    await channels[i]!.adopt(partial)
  }
  return partial.sigs
}

function snapshot(ch: ChannelN): CoSignedSnapshot {
  const latest = ch.latest!
  return { state: latest.state, sigs: [...latest.sigs] }
}
