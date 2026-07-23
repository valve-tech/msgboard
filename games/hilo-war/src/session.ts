import { keccak256, concatHex, bytesToHex, type Hex } from 'viem'
import {
  Channel, Transcript, makeEnvelope, verifyEnvelope, hashState,
  type ChannelDomain, type ChannelState, type CoSignedState, type Envelope,
  type MaskedDeckProvider, type Transport, type WireMasked, type WireShare, type WireShuffle,
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
    await this.runShuffles('SHUFFLE_A', 'SHUFFLE_B')

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
    })

    // 5. first flip
    this.flip = initialFlipState({ ante: this.cfg.ante, deckIndex: 0, warPot: 0n })
  }

  /** shared by setup and reshuffles; both sides adopt B's output deck */
  private async runShuffles(kindA: string, kindB: string): Promise<void> {
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
    } else {
      const env = await this.waitFor(kindA)
      const body = env.body as { before: WireMasked[]; after: WireShuffle }
      // v0 gap: we only check the BEFORE deck has 52 entries; deeper validation of the
      // initial masking is not possible here because initialDeck masks with fresh
      // randomness (regeneration won't match). A could mask a stacked deck — but the
      // SNARK provider proves correct initial masking, and in v0 the deck is also
      // remasked+shuffled by B, so A alone cannot know the final order: fairness holds
      // for ORDER, though a malformed initial deck (non-card points) would surface as
      // unmask failures.
      if (body.before.length !== DECK_SIZE)
        throw new Error('session: SHUFFLE_A before-deck must have 52 entries')
      if (!(await this.cfg.deck.verifyShuffle(this.agg, body.before, body.after, this.cfg.peer)))
        throw new Error('session: bad shuffle proof from A')
      const mine = await this.cfg.deck.shuffle(this.agg, body.after.deck, this.cfg.wallet)
      await this.post(kindB, { before: body.after.deck, after: mine })
      this.deckState = mine.deck
    }
  }

  private async reshuffle(): Promise<void> {
    const n = ++this.reshuffleCount
    await this.runShuffles(`SHUFFLE_A_R${n}`, `SHUFFLE_B_R${n}`)
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
