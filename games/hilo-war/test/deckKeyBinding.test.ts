// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// zk-core's zypherDeck.test.ts/deckBinding.test.ts: real WASM shuffles, so this suite is SLOW).
//
// Wires deckkey-binding-spec §B3's validate-before-sign guard into hilo-war's session, closing
// audit gap H-2: nothing previously called `verifyDealBinding` (dead code), role B never checked
// A's initial deck against the canonical D0 (only its length), and `shuffleRoot` went stale after
// a reshuffle. Each test below isolates exactly one of those three gaps.
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  ZypherDeckProvider, LocalTransport, TEST_DOMAIN, verifyDealBinding, uncompressPoint,
  type Envelope, type Transport, type ShuffleRound, type WireMasked, type WireShuffle,
} from '@msgboard/zk-cards-core'
import type { Hex } from 'viem'
import { Player, openSession, type DeckKeyReader } from '../src/session'

const ANTE = 5n, ESCROW_EACH = 1000n

function randomTableId(): Hex {
  return ('0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')) as Hex
}

/** Records every envelope a Player sends, keyed by kind, while still delivering it normally. */
class RecordingTransport implements Transport {
  readonly sent: Envelope[] = []
  constructor(private readonly inner: Transport) {}
  async send(msg: unknown): Promise<void> {
    this.sent.push(msg as Envelope)
    return this.inner.send(msg)
  }
  onMessage(handler: (msg: unknown) => void): void {
    this.inner.onMessage(handler)
  }
  bodyOf(kind: string): { before: WireMasked[]; after: WireShuffle } {
    const e = this.sent.find((x) => x.kind === kind)
    if (!e) throw new Error(`test: no envelope of kind ${kind} was sent`)
    return e.body as { before: WireMasked[]; after: WireShuffle }
  }
}

/** A reader that mirrors what an honest `create`/`join` would have registered on-chain. */
function honestReader(a: Player, b: Player): DeckKeyReader {
  return async (_tableId, seat) => {
    const pk = seat === 1 ? a.deckPublicKey : b.deckPublicKey
    const { x, y } = uncompressPoint(pk)
    return [x, y]
  }
}

/** initialDeck() returns a non-canonical (permuted) deck — a "stacked deck" start. */
class StackedDeckProvider extends ZypherDeckProvider {
  override async initialDeck(agg: Hex): Promise<WireMasked[]> {
    const d0 = await super.initialDeck(agg)
    return [d0[1]!, d0[0]!, ...d0.slice(2)] // swap the first two cards — still 52 valid ciphertexts, wrong order
  }
}

describe('deck-key-binding guard wired into hilo-war session (audit gap H-2)', () => {
  it('setup() succeeds on an honest deal (on-chain-sourced registeredKeys match the real aggregate)', async () => {
    const [ta, tb] = LocalTransport.pair()
    const wa = privateKeyToAccount(generatePrivateKey())
    const wb = privateKeyToAccount(generatePrivateKey())
    const deck = new ZypherDeckProvider()
    const tableId = randomTableId()
    let aRef!: Player, bRef!: Player
    const reader: DeckKeyReader = async (tid, seat) => honestReader(aRef, bRef)(tid, seat)
    const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    aRef = a; bRef = b

    await openSession(a, b)

    expect(a.channel.latest!.state.nonce).toBe(0n)
    expect(a.channel.fullySigned(a.channel.latest!)).toBe(true)
    expect(a.channel.latest!.state.jointKeyCommit).not.toBe(`0x${'00'.repeat(32)}`)
    expect(a.channel.latest!.state.shuffleRoot).not.toBe(`0x${'00'.repeat(32)}`)
    expect(a.channel.latest!.state).toEqual(b.channel.latest!.state)
  }, 180_000)

  it('setup() THROWS on a decoy deal — registeredKeys diverge from the actual gossiped aggregate', async () => {
    // Simulates the H-2 "wrong-agg decoy": the reader stands in for an on-chain registration that
    // does NOT match what was actually gossiped over KEYGEN for seat 2 (e.g. a poisoner who
    // registered the true agg on-chain but handed its peer a different key over the wire, or
    // equally, a peer who gossiped honestly but registered something else on-chain). Either way,
    // the client MUST refuse to co-sign rather than trust the wire.
    const [ta, tb] = LocalTransport.pair()
    const wa = privateKeyToAccount(generatePrivateKey())
    const wb = privateKeyToAccount(generatePrivateKey())
    const deck = new ZypherDeckProvider()
    const tableId = randomTableId()
    const decoy = await deck.keygen() // an unrelated third key — stands in for a mismatched on-chain registration
    let aRef!: Player
    const reader: DeckKeyReader = async (_tid, seat) => {
      if (seat === 2) {
        const { x, y } = uncompressPoint(decoy.pub)
        return [x, y]
      }
      const { x, y } = uncompressPoint(aRef.deckPublicKey)
      return [x, y]
    }
    const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    aRef = a

    let caught: Error | undefined
    try {
      await openSession(a, b)
    } catch (err) {
      caught = err as Error
    }
    // specifically the (a) jointKeyCommit check's reason — not some other failure
    expect(caught?.message).toMatch(/deal-binding validation failed/)
    expect(caught?.message).toMatch(/jointKeyCommit/)
    expect(a.channel.latest).toBeFalsy() // never co-signed
  }, 180_000)

  it('setup() THROWS when no deckKeyReader is supplied for a ZypherDeckProvider session', async () => {
    const [ta, tb] = LocalTransport.pair()
    const wa = privateKeyToAccount(generatePrivateKey())
    const wb = privateKeyToAccount(generatePrivateKey())
    const deck = new ZypherDeckProvider()
    const tableId = randomTableId()
    const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
    const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
    await expect(openSession(a, b)).rejects.toThrow(/deckKeyReader/)
  }, 180_000)

  it('role B rejects a non-canonical (stacked) initial deck from A', async () => {
    const [ta, tb] = LocalTransport.pair()
    const wa = privateKeyToAccount(generatePrivateKey())
    const wb = privateKeyToAccount(generatePrivateKey())
    const tableId = randomTableId()
    const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck: new StackedDeckProvider(), domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
    const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck: new ZypherDeckProvider(), domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
    a.setup().catch(() => {}) // A hangs waiting for SHUFFLE_B, which B never sends — swallow so it isn't unhandled
    await expect(b.setup()).rejects.toThrow(/canonical initial deck D0/)
  }, 180_000)

  it('reshuffle produces a fresh shuffleRoot that verifyDealBinding accepts against the NEW transcript', async () => {
    const [ta0, tb0] = LocalTransport.pair()
    const ta = new RecordingTransport(ta0)
    const tb = new RecordingTransport(tb0)
    const wa = privateKeyToAccount(generatePrivateKey())
    const wb = privateKeyToAccount(generatePrivateKey())
    const deck = new ZypherDeckProvider()
    const tableId = randomTableId()
    let aRef!: Player, bRef!: Player
    const reader: DeckKeyReader = async (tid, seat) => honestReader(aRef, bRef)(tid, seat)
    const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH, deckKeyReader: reader })
    aRef = a; bRef = b

    await openSession(a, b)
    const genesis = a.channel.latest!.state
    const registeredKeys: Hex[] = [a.deckPublicKey, b.deckPublicKey]

    // 26 flips exhaust the 52-card deck and trigger exactly one reshuffle at the boundary; a 27th
    // flip is required to observe the POST-reshuffle deck/shuffleRoot actually land in a co-signed
    // ChannelState (the reshuffle itself happens after hand 26's terminal co-sign).
    for (let k = 0; k < 27; k++) {
      await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    }
    const post = a.channel.latest!.state
    expect(post.jointKeyCommit).toBe(genesis.jointKeyCommit) // registered keys/agg never change
    expect(post.shuffleRoot).not.toBe(genesis.shuffleRoot)   // THE FIX: no longer stale
    expect(post.deckCommitment).not.toBe(genesis.deckCommitment)
    expect(post).toEqual(b.channel.latest!.state)

    // Reconstruct the reshuffle's ShuffleRound[] from what actually went over the wire and confirm
    // an independent client would accept this exact (deckCommitment, shuffleRoot) pair.
    const roundA = ta.bodyOf('SHUFFLE_A_R1')
    const roundB = tb.bodyOf('SHUFFLE_B_R1')
    const rounds: ShuffleRound[] = [
      { authorSeat: 1, before: roundA.before, after: roundA.after },
      { authorSeat: 2, before: roundB.before, after: roundB.after },
    ]
    const check = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: post.jointKeyCommit,
      shuffleRoot: post.shuffleRoot,
      deckCommitment: post.deckCommitment,
      rounds,
    })
    expect(check).toEqual({ ok: true })
  }, 300_000)
})
