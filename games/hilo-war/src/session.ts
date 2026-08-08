import { keccak256, concatHex, bytesToHex, type Hex } from 'viem'
import {
  Channel, Transcript, makeEnvelope, verifyEnvelope, hashState,
  ZypherDeckProvider, buildDealBinding, verifyDealBinding, ZERO_DEAL_BINDING, hashDeck, compressPoint,
  type ChannelDomain, type ChannelState, type CoSignedState, type Envelope,
  type MaskedDeckProvider, type ShuffleRound, type Transport, type WireMasked, type WireShare, type WireShuffle,
} from '@msgboard/zk-cards-core'
import {
  Phase, initialFlipState, applyMove, hashGameState, hashBetCommit,
  type HiLoState, type Move, type Seat, type Bet,
} from './rules'

const ZERO32: Hex = `0x${'00'.repeat(32)}`
const DECK_SIZE = 52

/**
 * Per-turn wall-clock timing, captured client-side as session-side metadata.
 *
 * CRITICAL: timing is metadata ONLY. It is kept on the Player (keyed by the
 * co-signed ChannelState nonce), NEVER inside an Envelope body and NEVER inside
 * the signed ChannelState. `hashState`/`entryDigest` read fixed tuples that do
 * not include these marks, so timing cannot change a state digest, an envelope
 * signature, the transcript head, or `gameStateHash`. A session that records
 * timing co-signs and verifies byte-for-byte identically to one that does not.
 *
 * Mirrors @msgboard/games TurnTiming. All fields are epoch milliseconds and
 * independently optional (a turn may be partially timed; legacy turns carry none).
 */
export interface TurnTiming {
  /** when the actor received the state it had to act on */
  offeredAt?: number
  /** when this party signed its next state */
  signedAt?: number
  /** when the co-sign exchange was submitted to the transport */
  broadcastAt?: number
  /** when the counter-signature / landing was observed */
  confirmedAt?: number
}

/** Injectable wall clock; the running driver uses Date.now(), tests pass a fake. */
export type Clock = () => number

export const systemClock: Clock = () => Date.now()

function spanMs(end: number | undefined, start: number | undefined): number | undefined {
  if (typeof end !== 'number' || typeof start !== 'number') return undefined
  const d = end - start
  return Number.isFinite(d) && d >= 0 ? d : undefined
}

/** decision delay: signedAt - offeredAt */
export function decisionMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.signedAt, t?.offeredAt)
}

/** network latency: confirmedAt - broadcastAt */
export function networkMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.confirmedAt, t?.broadcastAt)
}

/** whole-turn duration: confirmedAt - offeredAt */
export function totalMs(t: TurnTiming | undefined): number | undefined {
  return spanMs(t?.confirmedAt, t?.offeredAt)
}

/** wallet signer shape: viem accounts satisfy both message + typed-data signing */
export interface WalletSigner {
  address: Hex
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>
  signTypedData(args: any): Promise<Hex>
}

/**
 * Reads a seat's ON-CHAIN registered deck pubkey — i.e. `ZkTable.sol`'s `deckKeys(tableId, seat)`
 * getter (raw affine `(x, y)`, exactly as `create`/`join`'s `deckKey` param stores it). REQUIRED
 * when `deck` is a `ZypherDeckProvider`, so the validate-before-sign guard (deckkey-binding-spec
 * §B3, audit gap H-2) can source `registeredKeys` from the chain rather than from the gossiped
 * KEYGEN pubkeys — a seat that registers key X on-chain but gossips a different key Y over the
 * wire (the "wrong-agg decoy") is invisible to a check that trusts the wire.
 */
export type DeckKeyReader = (tableId: Hex, seat: 1 | 2) => Promise<[bigint, bigint]>

export interface PlayerConfig {
  role: Seat
  wallet: WalletSigner
  peer: Hex
  transport: Transport
  deck: MaskedDeckProvider
  domain: ChannelDomain
  tableId: Hex
  ante: bigint
  escrowEach: bigint
  /** wall clock for per-turn timing metadata; defaults to Date.now(). Injectable for tests. */
  clock?: Clock
  /** on-chain deck-key source for the setup() validate-before-sign guard — see `DeckKeyReader`. */
  deckKeyReader?: DeckKeyReader
}

export interface FlipChoices { bet: Bet; onRaise: 'CALL' | 'FOLD' }
export interface FlipResult { flip: HiLoState; myCard: number; opponentCard: number | null }

interface InboxEntry { env: Envelope; consumed: boolean }
interface Waiter { resolve: (e: Envelope) => void; reject: (err: Error) => void }

/**
 * Two-client session driver for Hi-Lo War: deck setup, private deals,
 * commit-reveal betting, showdowns / folds, channel co-signing, settle.
 * Both sides run the same code with mirrored roles over a Transport.
 */
export class Player {
  readonly channel: Channel
  readonly transcript: Transcript

  /** valid envelopes received from peer, in arrival order; never re-chained */
  private inbox: InboxEntry[] = []
  /** envelopes that failed verification or came from a non-peer address */
  private rejected: Envelope[] = []
  private waiters = new Map<string, Waiter[]>()
  private rxChain: Promise<void> = Promise.resolve()

  /**
   * Errors from invalid envelopes that arrived before a waiter registered.
   * Sessions are abort-on-error in v0 (no retry/recovery semantics), so a
   * poisoned kind rejecting the next waiter is the desired failure mode.
   */
  private pendingRejections = new Map<string, Error>()

  /**
   * Expected sequence number for the next valid envelope from peer.
   * Peer envelopes come from the peer's own monotone transcript, so seq must
   * equal the count of valid peer envelopes received so far.
   */
  private peerNextSeq = 0

  // deck crypto state, populated during setup()
  private deckSecret!: Hex
  private deckPub!: Hex
  private peerDeckPub!: Hex
  private agg!: Hex
  private deckState!: WireMasked[]
  private reshuffleCount = 0
  /**
   * The current `{jointKeyCommit, shuffleRoot}` co-signed into `ChannelState` — set at genesis
   * (setup()) and refreshed by reshuffle() so the on-chain challenge stays valid past the first
   * hand (deckkey-binding H-2 fix c). `jointKeyCommit` never actually changes post-setup (the
   * registered keys/agg are fixed for the table's life); only `shuffleRoot` moves.
   */
  private currentBinding!: { jointKeyCommit: Hex; shuffleRoot: Hex }

  /**
   * This seat's own registered deck pubkey (packed Zypher `pk` hex on the ZypherDeckProvider
   * path, or the equivalent gossiped pub on any other provider), populated after `setup()`'s
   * KEYGEN phase. Exposed read-only so a `DeckKeyReader` (which must model an on-chain read, per
   * `DeckKeyReader`'s own doc) can be backed, in tests, by a fixture that mirrors what a real
   * `create`/`join` call would have registered — production callers back it with an actual chain
   * read instead.
   */
  get deckPublicKey(): Hex {
    return this.deckPub
  }

  private flip!: HiLoState

  /** per-turn wall-clock timing, keyed by the co-signed ChannelState nonce (NON-SIGNED metadata) */
  readonly timing = new Map<bigint, TurnTiming>()
  private readonly now: Clock
  /** offeredAt for the turn currently in flight; set by the play/setup driver, consumed by coSign */
  private pendingOfferedAt?: number

  constructor(private cfg: PlayerConfig) {
    this.now = cfg.clock ?? systemClock
    this.channel = new Channel({
      domain: cfg.domain, tableId: cfg.tableId, me: cfg.wallet, peer: cfg.peer,
      role: cfg.role, escrow: 2n * cfg.escrowEach,
    })
    this.transcript = new Transcript(cfg.tableId)
    // serialize receipt processing so verification cannot reorder deliveries
    cfg.transport.onMessage((m) => {
      this.rxChain = this.rxChain.then(() => this.receive(m as Envelope))
    })
  }

  // ---------------------------------------------------------------- plumbing

  private async receive(e: Envelope): Promise<void> {
    const valid = (await verifyEnvelope(e)) && e.from.toLowerCase() === this.cfg.peer.toLowerCase()
    if (!valid) {
      // do not make invalid mail waitable; fail any pending waiter so callers see rejection
      this.rejected.push(e)
      const err = new Error(`session: invalid envelope of kind ${e.kind}`)
      const ws = this.waiters.get(e.kind)
      if (ws && ws.length > 0) {
        ws.shift()!.reject(err)
      } else if (!this.pendingRejections.has(e.kind)) {
        // store first error only; next waiter for this kind will see it
        this.pendingRejections.set(e.kind, err)
      }
      return
    }

    // seq must be exactly the count of valid peer envelopes received so far
    if (e.seq !== this.peerNextSeq) {
      const err = new Error(`session: out-of-order or replayed envelope (seq ${e.seq}, expected ${this.peerNextSeq})`)
      const ws = this.waiters.get(e.kind)
      if (ws && ws.length > 0) {
        ws.shift()!.reject(err)
      } else if (!this.pendingRejections.has(e.kind)) {
        this.pendingRejections.set(e.kind, err)
      }
      return
    }
    this.peerNextSeq++

    const ws = this.waiters.get(e.kind)
    if (ws && ws.length > 0) {
      this.inbox.push({ env: e, consumed: true })
      ws.shift()!.resolve(e)
    } else {
      this.inbox.push({ env: e, consumed: false })
    }
  }

  /** next unconsumed envelope of this kind, or await one */
  private waitFor(kind: string): Promise<Envelope> {
    // sessions are abort-on-error in v0 (no retry/recovery semantics), so a
    // poisoned kind rejecting the next waiter is the desired failure mode.
    if (this.pendingRejections.has(kind)) {
      const err = this.pendingRejections.get(kind)!
      this.pendingRejections.delete(kind)
      return Promise.reject(err)
    }
    const hit = this.inbox.find((x) => !x.consumed && x.env.kind === kind)
    if (hit) {
      hit.consumed = true
      return Promise.resolve(hit.env)
    }
    return new Promise<Envelope>((resolve, reject) => {
      const ws = this.waiters.get(kind) ?? []
      ws.push({ resolve, reject })
      this.waiters.set(kind, ws)
    })
  }

  /** hash-chain only the envelopes I send (own-send log), then transmit */
  private async post(kind: string, body: unknown): Promise<void> {
    const e = await makeEnvelope(
      this.cfg.wallet, this.cfg.tableId, this.transcript.entries.length, this.transcript.head, kind, body,
    )
    this.transcript.append(e)
    await this.cfg.transport.send(e)
  }

  // ---------------------------------------------------------------- co-signing

  /** role A proposes, role B accepts; both must compute `expected` identically */
  private async coSign(expected: ChannelState): Promise<void> {
    // timing (NON-SIGNED metadata): offeredAt is set by the driver when the turn
    // began; the remaining marks are stamped around the co-sign exchange. Consume
    // pendingOfferedAt up front so re-entrant turns don't cross wires.
    const offeredAt = this.pendingOfferedAt ?? this.now()
    this.pendingOfferedAt = undefined
    let timing: TurnTiming
    if (this.cfg.role === 'A') {
      const proposal = await this.channel.propose(expected)
      const signedAt = this.now() // this party's signature exists
      const broadcastAt = this.now()
      await this.post('STATE_PROPOSE', { coSigned: serializeCo(proposal) })
      const acc = await this.waitFor('STATE_ACCEPT')
      await this.channel.finalize(deserializeCo((acc.body as { coSigned: unknown }).coSigned))
      const confirmedAt = this.now() // counter-signature observed (channel.latest is both-signed)
      timing = { offeredAt, signedAt, broadcastAt, confirmedAt }
    } else {
      const env = await this.waitFor('STATE_PROPOSE')
      const proposal = deserializeCo((env.body as { coSigned: unknown }).coSigned)
      if (hashState(this.cfg.domain, proposal.state) !== hashState(this.cfg.domain, expected))
        throw new Error('session: peer proposed a state that differs from local expectation')
      const full = await this.channel.accept(proposal)
      const signedAt = this.now() // this party's signature exists (and the pair is now complete)
      const broadcastAt = this.now()
      await this.post('STATE_ACCEPT', { coSigned: serializeCo(full) })
      const confirmedAt = this.now() // fully co-signed state landed
      timing = { offeredAt, signedAt, broadcastAt, confirmedAt }
    }
    this.timing.set(expected.nonce, timing)
  }

  /**
   * The ONLY place channel balances change. Co-signed after the deal
   * (antes enter the pot) and at flip end (pot pays out / carries).
   */
  private async syncFlipState(flip: HiLoState): Promise<void> {
    const prev = this.channel.latest!.state
    const ante = this.cfg.ante
    let next: ChannelState
    if (flip.phase === Phase.BET_COMMIT) {
      next = {
        ...prev,
        nonce: prev.nonce + 1n,
        balanceA: prev.balanceA - ante,
        balanceB: prev.balanceB - ante,
        pot: flip.pot + flip.warPot,
        deckCommitment: deckCommitment(this.deckState),
        // carries the post-reshuffle shuffleRoot forward (deckkey-binding H-2 fix c); a no-op
        // outside a reshuffle epoch since currentBinding.shuffleRoot is otherwise unchanged.
        shuffleRoot: this.currentBinding.shuffleRoot,
        phase: flip.phase,
        gameStateHash: hashGameState(flip),
      }
    } else if (flip.phase === Phase.FLIP_DONE) {
      const extraA = flip.contributed.A - ante
      const extraB = flip.contributed.B - ante
      let balanceA = prev.balanceA - extraA
      let balanceB = prev.balanceB - extraB
      if (flip.result) {
        if (flip.result.winner === 'A') balanceA += flip.result.amount
        else balanceB += flip.result.amount
      }
      next = {
        ...prev,
        nonce: prev.nonce + 1n,
        balanceA, balanceB,
        pot: flip.warPot, // 0n on decisive flips; the carry on ties
        phase: flip.phase,
        gameStateHash: hashGameState(flip),
      }
    } else {
      throw new Error(`session: syncFlipState in unexpected phase ${flip.phase}`)
    }
    await this.coSign(next)
  }

  // ---------------------------------------------------------------- setup

  async setup(): Promise<void> {
    // 1. deck keygen exchange; aggregate in canonical order (A's pub first)
    const keys = await this.cfg.deck.keygen()
    this.deckSecret = keys.secret
    this.deckPub = keys.pub
    await this.post('KEYGEN', { pub: this.deckPub })
    const peerKey = await this.waitFor('KEYGEN')
    this.peerDeckPub = (peerKey.body as { pub: Hex }).pub
    this.agg = this.cfg.deck.aggregate(
      this.cfg.role === 'A' ? [this.deckPub, this.peerDeckPub] : [this.peerDeckPub, this.deckPub],
    )

    // 2/3. double shuffle: A masks + shuffles, B shuffles A's output
    const rounds = await this.runShuffles('SHUFFLE_A', 'SHUFFLE_B')

    // deck-key binding (deckkey-binding-spec §B3): only computable/meaningful on the Zypher
    // (Baby-JubJub/EdOnBN254) provider — that is the ONLY curve ZkTable's on-chain verify52
    // dispute path understands (spec §C3 struck the secp256k1/AttestedElGamalDeck path). A
    // session on any other provider has no on-chain attribution available; ZERO is the correct,
    // documented placeholder there (matches today's split-only fallback).
    if (this.cfg.deck instanceof ZypherDeckProvider) {
      const binding = buildDealBinding(this.agg, rounds)
      // VALIDATE-BEFORE-SIGN GUARD (audit gap H-2, spec §B3 hard client obligation). A poisoner
      // can commit the TRUE agg on-chain but hand its peer a decoy `agg'`/deck: the chain has no
      // way to prove `pkc == refresh(agg)` from ITS side, so this off-chain recheck is the only
      // thing that stops it. `registeredKeys` MUST come from an on-chain read of ZkTable's
      // `deckKeys[tableId][seat]` — never from the gossiped KEYGEN pubkeys already sitting in
      // `this.deckPub`/`this.peerDeckPub` (a seat can register X on-chain and gossip Y over the
      // wire; trusting the wire would validate the aggregate against the WRONG registered keys,
      // exactly the gap this guard exists to close).
      const reader = this.cfg.deckKeyReader
      if (!reader) {
        throw new Error(
          'session: ZypherDeckProvider requires a deckKeyReader (on-chain ZkTable.deckKeys getter) — refusing to co-sign a deal binding with no on-chain-verified registered keys',
        )
      }
      const [seat1, seat2] = await Promise.all([reader(this.cfg.tableId, 1), reader(this.cfg.tableId, 2)])
      const registeredKeys: Hex[] = [compressPoint(seat1[0], seat1[1]), compressPoint(seat2[0], seat2[1])]
      const check = await verifyDealBinding({
        provider: this.cfg.deck,
        registeredKeys,
        jointKeyCommit: binding.jointKeyCommit,
        shuffleRoot: binding.shuffleRoot,
        deckCommitment: deckCommitment(this.deckState),
        rounds,
      })
      if (!check.ok) {
        throw new Error(`session: deal-binding validation failed — refusing to co-sign a decoy deck (${check.reason})`)
      }
      this.currentBinding = { jointKeyCommit: binding.jointKeyCommit, shuffleRoot: binding.shuffleRoot }
    } else {
      this.currentBinding = { jointKeyCommit: ZERO_DEAL_BINDING.jointKeyCommit, shuffleRoot: ZERO_DEAL_BINDING.shuffleRoot }
    }

    // 4. genesis co-sign at nonce 0 — the turn was offered when setup began;
    // approximate with now() at the co-sign boundary (setup has no discrete decision)
    this.pendingOfferedAt = this.now()
    await this.coSign({
      tableId: this.cfg.tableId,
      nonce: 0n,
      balanceA: this.cfg.escrowEach,
      balanceB: this.cfg.escrowEach,
      pot: 0n,
      deckCommitment: deckCommitment(this.deckState),
      phase: Phase.SETUP,
      gameStateHash: ZERO32,
      jointKeyCommit: this.currentBinding.jointKeyCommit,
      shuffleRoot: this.currentBinding.shuffleRoot,
    })

    // 5. first flip
    this.flip = initialFlipState({ ante: this.cfg.ante, deckIndex: 0, warPot: 0n })
  }

  /**
   * Shared by setup and reshuffles; both sides adopt B's output deck. Returns the two shuffle
   * contributions in ZkTable's canonical seat order (1=A, 2=B) — both roles compute the SAME
   * `ShuffleRound[]` labeling regardless of which one executed this call locally, since each
   * side observes both SHUFFLE_A/SHUFFLE_B envelope bodies over the wire (§B2's `authorSeat`).
   */
  private async runShuffles(kindA: string, kindB: string): Promise<ShuffleRound[]> {
    if (this.cfg.role === 'A') {
      const before = await this.cfg.deck.initialDeck(this.agg)
      const after = await this.cfg.deck.shuffle(this.agg, before, this.cfg.wallet)
      await this.post(kindA, { before, after })
      const env = await this.waitFor(kindB)
      const body = env.body as { before: WireMasked[]; after: WireShuffle }
      if (JSON.stringify(body.before) !== JSON.stringify(after.deck))
        throw new Error('session: SHUFFLE_B before-deck does not match my shuffle output')
      if (!(await this.cfg.deck.verifyShuffle(this.agg, body.before, body.after, this.cfg.peer)))
        throw new Error('session: bad shuffle proof from B')
      this.deckState = body.after.deck
      return [
        { authorSeat: 1, before, after },
        { authorSeat: 2, before: body.before, after: body.after },
      ]
    } else {
      const env = await this.waitFor(kindA)
      const body = env.body as { before: WireMasked[]; after: WireShuffle }
      if (body.before.length !== DECK_SIZE)
        throw new Error('session: SHUFFLE_A before-deck must have 52 entries')
      // deckkey-binding H-2 fix (b) — canonical-head check: on the ZypherDeckProvider path,
      // `initialDeck(agg)` is a PURE function of the joint key (deterministic masking per card
      // index — see zypherDeck.ts), so B can independently recompute the canonical D0 and reject
      // A starting the shuffle chain from a stacked deck. NOT possible on AttestedElGamalDeck:
      // its `initialDeck` masks with fresh per-call randomness (see elgamal.ts's `maskCard`
      // default `r`), so two calls never match even for an honest A — that path keeps the
      // length-only check (documented v0 gap, unchanged by this fix). Either way the SNARK/
      // signature shuffle proof below still proves correct RE-masking; the ORDER-fairness
      // argument for the non-canonical-checkable path is unchanged from before.
      if (this.cfg.deck instanceof ZypherDeckProvider) {
        const canonicalD0 = await this.cfg.deck.initialDeck(this.agg)
        if (hashDeck(body.before) !== hashDeck(canonicalD0)) {
          throw new Error('session: SHUFFLE_A before-deck is not the canonical initial deck D0 — refusing a stacked-deck start')
        }
      }
      if (!(await this.cfg.deck.verifyShuffle(this.agg, body.before, body.after, this.cfg.peer)))
        throw new Error('session: bad shuffle proof from A')
      const mine = await this.cfg.deck.shuffle(this.agg, body.after.deck, this.cfg.wallet)
      await this.post(kindB, { before: body.after.deck, after: mine })
      this.deckState = mine.deck
      return [
        { authorSeat: 1, before: body.before, after: body.after },
        { authorSeat: 2, before: body.after.deck, after: mine },
      ]
    }
  }

  private async reshuffle(): Promise<void> {
    const n = ++this.reshuffleCount
    const rounds = await this.runShuffles(`SHUFFLE_A_R${n}`, `SHUFFLE_B_R${n}`)
    // deckkey-binding H-2 fix (c): rebuild the transcript + `shuffleRoot` for the NEW deck so the
    // co-signed `shuffleRoot` doesn't go stale relative to the refreshed `deckCommitment` past the
    // first hand. `jointKeyCommit` is untouched — the registered keys/agg never change post-setup
    // (`runShuffles` reuses `this.agg` unconditionally), so only `shuffleRoot` needs recomputing.
    // The fresh value is carried into the next co-signed `ChannelState` by `syncFlipState`'s
    // BET_COMMIT branch (the same branch that refreshes `deckCommitment`); the on-chain challenge
    // path already reads whatever `shuffleRoot` the disputed co-signed state carries, so nothing
    // on the contract side needs to change.
    if (this.cfg.deck instanceof ZypherDeckProvider) {
      const binding = buildDealBinding(this.agg, rounds)
      // VALIDATE-BEFORE-SIGN GUARD (F3, 2026-08) — setup()'s H-2 guard (audit gap H-2, spec §B3)
      // only ever covered the GENESIS deal: a poisoner who behaves honestly through setup() (or
      // whose decoy setup() already caught) could still inject a decoy shuffle chain at a LATER
      // reshuffle, since nothing re-ran this check past hand 1. Every reshuffle rebuilds
      // `shuffleRoot` from a fresh `rounds` transcript exactly like setup()'s genesis deal does,
      // so it gets the identical re-check before that refreshed state is ever co-signed (the
      // next co-sign happens in `syncFlipState`'s BET_COMMIT branch, AFTER this function
      // returns — see this function's header). `jointKeyCommit`/the registered keys are
      // unchanged (the agg is fixed post-setup, per this function's header); only
      // `shuffleRoot`/`deckCommitment` are fresh — but a decoy injected at THIS shuffle chain is
      // exactly as real a threat as one at genesis and deserves the same guard, not a weaker one.
      const reader = this.cfg.deckKeyReader
      if (!reader) {
        throw new Error(
          'session: ZypherDeckProvider requires a deckKeyReader (on-chain ZkTable.deckKeys getter) — refusing to co-sign a reshuffled deal binding with no on-chain-verified registered keys',
        )
      }
      const [seat1, seat2] = await Promise.all([reader(this.cfg.tableId, 1), reader(this.cfg.tableId, 2)])
      const registeredKeys: Hex[] = [compressPoint(seat1[0], seat1[1]), compressPoint(seat2[0], seat2[1])]
      const check = await verifyDealBinding({
        provider: this.cfg.deck,
        registeredKeys,
        jointKeyCommit: this.currentBinding.jointKeyCommit,
        shuffleRoot: binding.shuffleRoot,
        deckCommitment: deckCommitment(this.deckState),
        rounds,
      })
      if (!check.ok) {
        throw new Error(`session: deal-binding validation failed on reshuffle — refusing to co-sign a decoy deck (${check.reason})`)
      }
      this.currentBinding = { jointKeyCommit: this.currentBinding.jointKeyCommit, shuffleRoot: binding.shuffleRoot }
    }
  }

  // ---------------------------------------------------------------- play

  async playFlip(choices: FlipChoices): Promise<FlipResult> {
    // turn offered: the actor received the prior co-signed state and begins this flip
    this.pendingOfferedAt = this.now()
    const me = this.cfg.role
    const them = other(me)
    let flip = this.flip
    const deckIndex = flip.deckIndex
    const mySlot = deckIndex + (me === 'A' ? 0 : 1)
    const theirSlot = deckIndex + (me === 'A' ? 1 : 0)
    const myMasked = this.deckState[mySlot]!
    const theirMasked = this.deckState[theirSlot]!
    const tableTag = `session[${this.cfg.tableId.slice(0, 12)}…]`

    // 1. private deal: exchange shares of EACH OTHER's cards; my share of my
    //    own card is computed locally and never sent (it is the showdown reveal).
    const myShareOfTheirs = await this.cfg.deck.share(this.deckSecret, theirMasked, this.slotCtx(theirSlot))
    await this.post('DEAL_SHARE', { slot: theirSlot, share: myShareOfTheirs })
    const dealEnv = await this.waitFor('DEAL_SHARE')
    const dealBody = dealEnv.body as { slot: number; share: WireShare }
    if (dealBody.slot !== mySlot)
      throw new Error(`${tableTag}: deal share for wrong slot (got ${dealBody.slot}, expected ${mySlot}, deckIndex ${deckIndex})`)
    if (!(await this.cfg.deck.verifyShare(this.peerDeckPub, myMasked, dealBody.share, this.slotCtx(mySlot))))
      throw new Error(`${tableTag}: bad deal share from peer (slot ${mySlot}, deckIndex ${deckIndex})`)
    const myOwnShare = await this.cfg.deck.share(this.deckSecret, myMasked, this.slotCtx(mySlot))
    const myCard = this.cfg.deck.unmask(myMasked, [dealBody.share, myOwnShare])
    flip = mustApply(flip, { kind: 'DEAL_DONE' })
    await this.syncFlipState(flip)

    // the terminal-flip turn (showdown/fold settlement) is offered now — the
    // deal turn was just co-signed and the betting decision begins here
    this.pendingOfferedAt = this.now()

    // 2. simultaneous bet: commit, then open in seat order (A first) so both
    //    sides walk identical state sequences.
    const salt = randomSalt()
    const myCommitment = hashBetCommit(choices.bet, salt)
    await this.post('BET_COMMIT', { commitment: myCommitment })
    const commitEnv = await this.waitFor('BET_COMMIT')
    const theirCommitment = (commitEnv.body as { commitment: Hex }).commitment
    // apply in seat order (A first): rules are order-agnostic, but hashGameState
    // serializes object key insertion order, so both sides must build identically
    const commits: Record<Seat, Move> = {
      [me]: { kind: 'BET_COMMIT', by: me, commitment: myCommitment },
      [them]: { kind: 'BET_COMMIT', by: them, commitment: theirCommitment },
    } as Record<Seat, Move>
    flip = mustApply(flip, commits.A)
    flip = mustApply(flip, commits.B)
    await this.post('BET_OPEN', { bet: choices.bet, salt })
    const openEnv = await this.waitFor('BET_OPEN')
    const theirOpen = openEnv.body as { bet: Bet; salt: Hex }
    const opens: Record<Seat, Move> = {
      [me]: { kind: 'BET_OPEN', by: me, bet: choices.bet, salt },
      [them]: { kind: 'BET_OPEN', by: them, bet: theirOpen.bet, salt: theirOpen.salt },
    } as Record<Seat, Move>
    flip = mustApply(flip, opens.A) // seat order again: identical key insertion on both sides
    flip = mustApply(flip, opens.B)

    // 3. one side raised: the raiser only awaits; the other side only posts.
    if (flip.phase === Phase.CALL_OR_FOLD) {
      if (flip.raiser === me) {
        const env = await this.waitFor('CALL_OR_FOLD')
        const move = (env.body as { move: 'CALL' | 'FOLD' }).move
        flip = mustApply(flip, { kind: move, by: them })
      } else {
        await this.post('CALL_OR_FOLD', { move: choices.onRaise })
        flip = mustApply(flip, { kind: choices.onRaise, by: me })
      }
    }
    const folded = flip.phase === Phase.FLIP_DONE && flip.foldedCardHidden

    // 4. showdown — skipped entirely on the fold path: NEITHER side posts or
    //    awaits REVEAL_SHARE there (the folder's card stays masked forever).
    let opponentCard: number | null = null
    if (!folded) {
      await this.post('REVEAL_SHARE', { slot: mySlot, share: myOwnShare })
      const revealEnv = await this.waitFor('REVEAL_SHARE')
      const revealBody = revealEnv.body as { slot: number; share: WireShare }
      if (revealBody.slot !== theirSlot)
        throw new Error(`${tableTag}: reveal for wrong slot (got ${revealBody.slot}, expected ${theirSlot}, deckIndex ${deckIndex})`)
      if (!(await this.cfg.deck.verifyShare(this.peerDeckPub, theirMasked, revealBody.share, this.slotCtx(theirSlot))))
        throw new Error(`${tableTag}: bad reveal share from peer (slot ${theirSlot}, deckIndex ${deckIndex})`)
      opponentCard = this.cfg.deck.unmask(theirMasked, [revealBody.share, myShareOfTheirs])
      const cardA = me === 'A' ? myCard : opponentCard
      const cardB = me === 'A' ? opponentCard : myCard
      flip = mustApply(flip, { kind: 'SHOWDOWN', cardA, cardB })
    }

    // 5. co-sign the terminal flip state, then roll to the next deal window
    await this.syncFlipState(flip)
    const nextIndex = deckIndex + 2
    let nextDeckIndex = nextIndex
    if (nextIndex + 1 >= DECK_SIZE) {
      await this.reshuffle()
      nextDeckIndex = 0
    }
    const done = flip
    this.flip = initialFlipState({ ante: this.cfg.ante, deckIndex: nextDeckIndex, warPot: done.warPot })
    return { flip: done, myCard, opponentCard }
  }

  // ---------------------------------------------------------------- settle

  /** role-agnostic: the CALLER proposes the settle; peer runs acceptSettle() */
  async requestSettle(): Promise<CoSignedState> {
    const next = this.settleState()
    const proposal = await this.channel.propose(next)
    await this.post('SETTLE_PROPOSE', { coSigned: serializeCo(proposal) })
    const acc = await this.waitFor('SETTLE_ACCEPT')
    await this.channel.finalize(deserializeCo((acc.body as { coSigned: unknown }).coSigned))
    return this.channel.latest!
  }

  async acceptSettle(): Promise<CoSignedState> {
    const env = await this.waitFor('SETTLE_PROPOSE')
    const proposal = deserializeCo((env.body as { coSigned: unknown }).coSigned)
    const expected = this.settleState()
    if (proposal.state.phase !== Phase.SETTLED) throw new Error('session: settle proposal must be phase SETTLED')
    if (proposal.state.pot !== 0n) throw new Error('session: settle proposal must zero the pot')
    if (hashState(this.cfg.domain, proposal.state) !== hashState(this.cfg.domain, expected))
      throw new Error('session: settle proposal carry-split does not match local expectation')
    const full = await this.channel.accept(proposal)
    await this.post('SETTLE_ACCEPT', { coSigned: serializeCo(full) })
    return full
  }

  /** latest.pot holds the war carry: split evenly, odd unit goes to A */
  private settleState(): ChannelState {
    const latest = this.channel.latest!.state
    const carry = latest.pot
    const half = carry / 2n
    return {
      ...latest,
      nonce: latest.nonce + 1n,
      phase: Phase.SETTLED,
      pot: 0n,
      balanceA: latest.balanceA + half + (carry % 2n),
      balanceB: latest.balanceB + half,
    }
  }

  private slotCtx(slot: number): string {
    return `${this.cfg.tableId}/slot-${slot}`
  }
}

export function openSession(a: Player, b: Player): Promise<[void, void]> {
  return Promise.all([a.setup(), b.setup()])
}

// ------------------------------------------------------------------- helpers

function deckCommitment(deck: WireMasked[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

/** bigint channel-state fields → strings, for JSON envelope bodies */
function serializeCo(c: CoSignedState): unknown {
  const s = c.state
  return { ...c, state: { ...s, nonce: s.nonce.toString(), balanceA: s.balanceA.toString(), balanceB: s.balanceB.toString(), pot: s.pot.toString() } }
}

function deserializeCo(raw: unknown): CoSignedState {
  const c = raw as { state: Record<string, string | undefined | null>; sigA?: Hex; sigB?: Hex }
  const s = c.state
  if (s.tableId == null) throw new Error('session: malformed coSigned — missing tableId')
  if (s.nonce == null) throw new Error('session: malformed coSigned — missing nonce')
  if (s.balanceA == null) throw new Error('session: malformed coSigned — missing balanceA')
  if (s.balanceB == null) throw new Error('session: malformed coSigned — missing balanceB')
  if (s.pot == null) throw new Error('session: malformed coSigned — missing pot')
  if (s.deckCommitment == null) throw new Error('session: malformed coSigned — missing deckCommitment')
  if (s.phase == null) throw new Error('session: malformed coSigned — missing phase')
  if (s.gameStateHash == null) throw new Error('session: malformed coSigned — missing gameStateHash')
  return { ...c, state: { ...s, nonce: BigInt(s.nonce), balanceA: BigInt(s.balanceA), balanceB: BigInt(s.balanceB), pot: BigInt(s.pot) } } as CoSignedState
}

function mustApply(state: HiLoState, move: Move): HiLoState {
  const r = applyMove(state, move)
  if ('error' in r) throw new Error(r.error)
  return r.state
}

function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

function randomSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}
