import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { type Hex } from 'viem'
import {
  AttestedElGamalDeck,
  maskCard,
  serializeMasked,
  deserializePoint,
  type WireMasked,
} from '@msgboard/zk-cards-core'
import { jointKey } from '../src/deckN'
import {
  ctxFor,
  collectShares,
  verifyAllShares,
  revealCommunity,
  revealHole,
  RevealFault,
} from '../src/revealN'

// A seat carries an ElGamal deck keypair plus a wallet account; for reveal we only
// need the deck keypair (secret/pub). tableId is an arbitrary 32-byte tag.
const TABLE: Hex = ('0x' + '11'.repeat(32)) as Hex

const mkSeat = async (p: AttestedElGamalDeck) => {
  const k = await p.keygen()
  const acct = privateKeyToAccount(generatePrivateKey())
  return { ...k, addr: acct.address as Hex, signer: acct }
}

type Seat = Awaited<ReturnType<typeof mkSeat>>

// Build a tiny "dealt deck": a freshly masked deck under the joint key, where a
// chosen slot holds a chosen card index. We don't need a full shuffle chain to
// exercise the reveal machinery — reveal operates on whatever masked card sits in
// a slot. This keeps the suite fast and deterministic.
const dealtDeck = (seats: Seat[], slotToCard: Record<number, number>, size = 6): WireMasked[] => {
  const agg = deserializePoint(jointKey(new AttestedElGamalDeck(), seats.map((s) => s.pub)))
  return Array.from({ length: size }, (_, slot) =>
    serializeMasked(maskCard(agg, slotToCard[slot] ?? slot)),
  )
}

describe('N-party community reveal — every seat contributes a share', () => {
  it('combines ALL N shares to the right card index', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 0: 42 })

    const shares = await collectShares(p, seats, deck, 0, TABLE)
    expect(shares.length).toBe(4)
    expect(revealCommunity(p, deck, 0, shares)).toBe(42)
  })

  it('THROWS when a share is missing (community needs all N)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 0: 7 })

    const shares = await collectShares(p, seats, deck, 0, TABLE)
    // drop one seat's share => incomplete => not a card point => fault
    expect(() => revealCommunity(p, deck, 0, shares.slice(0, 3))).toThrow(RevealFault)
  })
})

describe('share soundness (Chaum–Pedersen) — verifyAllShares', () => {
  it('accepts an honest set of shares', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 1: 9 })
    const shares = await collectShares(p, seats, deck, 1, TABLE)
    expect(await verifyAllShares(p, seats.map((s) => s.pub), deck, 1, TABLE, shares)).toBe(true)
  })

  it('REJECTS a forged share: a share computed under a different secret', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 1: 9 })
    const shares = await collectShares(p, seats, deck, 1, TABLE)

    // forge seat 1's share point with an unrelated secret, keep its (now-stale) proof
    const ctx = ctxFor(TABLE, 1)
    const evil = await mkSeat(p)
    const forged = await p.share(evil.secret, deck[1]!, ctx)
    const tampered = shares.map((rs, i) =>
      i === 1 ? { from: seats[1]!.pub, share: forged } : rs,
    )
    expect(await verifyAllShares(p, seats.map((s) => s.pub), deck, 1, TABLE, tampered)).toBe(false)
  })

  it('REJECTS a tampered proof', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 1: 9 })
    const shares = await collectShares(p, seats, deck, 1, TABLE)

    const good = shares[0]!
    const proof = good.share.proof as { t1: Hex; t2: Hex; z: Hex }
    const z = proof.z
    const flippedZ = (z.slice(0, -1) + (z.endsWith('0') ? '1' : '0')) as Hex
    const tampered = shares.map((rs, i) =>
      i === 0
        ? { ...rs, share: { ...rs.share, proof: { ...proof, z: flippedZ } } }
        : rs,
    )
    expect(await verifyAllShares(p, seats.map((s) => s.pub), deck, 1, TABLE, tampered)).toBe(false)
  })

  it('REJECTS a share whose ctx is for a different slot (replay)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 1: 9, 2: 9 })
    // share collected for slot 2, presented as if for slot 1
    const sharesFor2 = await collectShares(p, seats, deck, 2, TABLE)
    expect(await verifyAllShares(p, seats.map((s) => s.pub), deck, 1, TABLE, sharesFor2)).toBe(false)
  })
})

describe('N-party hole reveal — readable by exactly ONE seat', () => {
  it('owner combines its own share + the N-1 peer shares to learn the card', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const target = 2
    const deck = dealtDeck(seats, { 5: 33 })

    const ctx = ctxFor(TABLE, 5)
    const peers = seats.filter((_, i) => i !== target)
    const peerShares = await collectShares(p, peers, deck, 5, TABLE)
    const ownShare = await p.share(seats[target]!.secret, deck[5]!, ctx)

    expect(revealHole(p, deck, 5, ownShare, peerShares)).toBe(33)
  })

  it('HIDING: the N-1 peer shares alone do NOT reveal the card to a non-owner', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const target = 2
    const deck = dealtDeck(seats, { 5: 33 })

    // everyone EXCEPT the target contributes — these are the shares the table broadcasts
    const peers = seats.filter((_, i) => i !== target)
    const peerShares = await collectShares(p, peers, deck, 5, TABLE)

    // a passive observer (or any non-owner) has only the N-1 peer shares: combining
    // them is short exactly the target's share => not a card point => stays hidden.
    expect(() => revealCommunity(p, deck, 5, peerShares)).toThrow(RevealFault)

    // and only WITH the owner's own share does it resolve.
    const ownShare = await p.share(seats[target]!.secret, deck[5]!, ctxFor(TABLE, 5))
    expect(revealHole(p, deck, 5, ownShare, peerShares)).toBe(33)
  })
})

describe('reveal-time integrity gate — corrupted (non-permutation) deck is DETECTED', () => {
  // Task-1 attestation guarantees ATTRIBUTION, not permutation-correctness: a
  // malicious shuffler could duplicate/drop a card and still produce a valid attest
  // signature over keccak(before||after). In v1 the REVEAL is the real integrity
  // gate — a corrupted slot must surface as a DETECTABLE, ATTRIBUTABLE fault here.
  it('a slot corrupted to a non-card plaintext throws an attributable fault at reveal', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const deck = dealtDeck(seats, { 0: 12, 1: 12 }) as WireMasked[]

    // Corrupt slot 1's c2 by adding the joint key point. cardPoint(i) = G*(i+1); the
    // joint key is G*Σsk (a large, ~random scalar), so the new plaintext is NOT any
    // of the 52 card points. The shares are still honest (real proofs over this c2),
    // so verifyAllShares passes — yet the COMBINE must fail: this is exactly the
    // "passed attestation but isn't a real card" case.
    const agg = deserializePoint(jointKey(p, seats.map((s) => s.pub)))
    const m = deck[1]!
    const corrupted = serializeMasked({ c1: deserializePoint(m.c1), c2: deserializePoint(m.c2).add(agg) })
    const badDeck = deck.map((d, i) => (i === 1 ? corrupted : d))

    const shares = await collectShares(p, seats, badDeck, 1, TABLE)
    // shares themselves are valid for the (corrupted) ciphertext...
    expect(await verifyAllShares(p, seats.map((s) => s.pub), badDeck, 1, TABLE, shares)).toBe(true)
    // ...but the reveal of slot 1 surfaces a fault naming the slot.
    let caught: unknown
    try {
      revealCommunity(p, badDeck, 1, shares)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RevealFault)
    expect((caught as RevealFault).slot).toBe(1)
    expect((caught as Error).message).toMatch(/slot 1/)

    // the UNCORRUPTED slot still reveals fine — the fault is localized.
    const ok = await collectShares(p, seats, badDeck, 0, TABLE)
    expect(revealCommunity(p, badDeck, 0, ok)).toBe(12)
  })

  it('a hole reveal of a corrupted slot also surfaces the fault (not a bogus card)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const target = 1
    const deck = dealtDeck(seats, { 4: 20 })

    const agg = deserializePoint(jointKey(p, seats.map((s) => s.pub)))
    const m = deck[4]!
    deck[4] = serializeMasked({ c1: deserializePoint(m.c1), c2: deserializePoint(m.c2).add(agg) })

    const peers = seats.filter((_, i) => i !== target)
    const peerShares = await collectShares(p, peers, deck, 4, TABLE)
    const ownShare = await p.share(seats[target]!.secret, deck[4]!, ctxFor(TABLE, 4))

    let caught: unknown
    try {
      revealHole(p, deck, 4, ownShare, peerShares)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RevealFault)
    expect((caught as RevealFault).slot).toBe(4)
  })
})
