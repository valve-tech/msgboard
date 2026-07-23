import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { isHex, type Hex } from 'viem'
import { AttestedElGamalDeck, type WireMasked } from '@msgboard/zk-cards-core'
import { jointKey, runShuffleChain, verifyShuffleChain } from '../src/deckN'

// A "seat" carries the deck keypair (secp256k1, for ElGamal) plus a wallet
// account (the attest signer whose address gates each shuffle round).
const mkSeat = async (p: AttestedElGamalDeck) => {
  const k = await p.keygen()
  const acct = privateKeyToAccount(generatePrivateKey())
  return { ...k, addr: acct.address as Hex, signer: acct }
}

const deckDigest = (deck: WireMasked[]): string =>
  deck.map((m) => `${m.c1}|${m.c2}`).join(',')

describe('N-party joint key', () => {
  it('aggregation is order-independent and yields a valid compressed point (N=5)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3, 4].map(() => mkSeat(p)))
    const pubs = seats.map((s) => s.pub)

    const agg = jointKey(p, pubs)
    const shuffled = [pubs[3]!, pubs[0]!, pubs[4]!, pubs[1]!, pubs[2]!]
    const aggShuffled = jointKey(p, shuffled)

    // commutative sum => order-independent
    expect(agg).toEqual(aggShuffled)
    // compressed secp256k1 point: 33 bytes => 0x + 66 hex chars, prefix 02/03
    expect(isHex(agg)).toBe(true)
    expect(agg.length).toBe(2 + 66)
    expect(['02', '03']).toContain(agg.slice(2, 4))
  })

  it('joint key equals the provider aggregate (delegation, not a re-impl)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const pubs = seats.map((s) => s.pub)
    expect(jointKey(p, pubs)).toEqual(p.aggregate(pubs))
  })
})

describe('N-party sequential shuffle chain', () => {
  it('N=5 shuffle chain is a permutation that round-trips under all shares', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3, 4].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { finalDeck } = await runShuffleChain(p, agg, seats)
    const out: number[] = []
    for (let slot = 0; slot < 52; slot++) {
      const shares = []
      for (const s of seats) shares.push(await p.share(s.secret, finalDeck[slot]!, `table/slot/${slot}`))
      out.push(p.unmask(finalDeck[slot]!, shares))
    }
    expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i))
  })

  it('N=3 shuffle chain also round-trips (small table)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { finalDeck, rounds } = await runShuffleChain(p, agg, seats)
    expect(rounds.length).toBe(3)
    const out: number[] = []
    for (let slot = 0; slot < 52; slot++) {
      const shares = []
      for (const s of seats) shares.push(await p.share(s.secret, finalDeck[slot]!, `t/${slot}`))
      out.push(p.unmask(finalDeck[slot]!, shares))
    }
    expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i))
  })
})

describe('shuffle chain verification + tamper rejection', () => {
  it('verifies an honest chain (N=4)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { initial, rounds } = await runShuffleChain(p, agg, seats)
    const ok = await verifyShuffleChain(p, agg, initial, rounds, seats.map((s) => s.addr))
    expect(ok).toBe(true)
  })

  it('rejects a chain whose round deck has been tampered (one byte of c2)', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { initial, rounds } = await runShuffleChain(p, agg, seats)
    // flip one nibble of round 2's slot-0 c2 ciphertext component
    const c2 = rounds[1]!.deck[0]!.c2
    const flipped = (c2.slice(0, -1) + (c2.endsWith('0') ? '1' : '0')) as Hex
    const tamperedRounds = rounds.map((r, i) =>
      i === 1
        ? { ...r, deck: r.deck.map((m, j) => (j === 0 ? { ...m, c2: flipped } : m)) }
        : r,
    )
    const ok = await verifyShuffleChain(p, agg, initial, tamperedRounds, seats.map((s) => s.addr))
    expect(ok).toBe(false)
  })

  it('rejects a wrong signerAddrs order', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { initial, rounds } = await runShuffleChain(p, agg, seats)
    const wrongOrder = seats.map((s) => s.addr)
    ;[wrongOrder[0], wrongOrder[1]] = [wrongOrder[1]!, wrongOrder[0]!]
    const ok = await verifyShuffleChain(p, agg, initial, rounds, wrongOrder)
    expect(ok).toBe(false)
  })

  it('rejects when a round count mismatches the signer list', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2, 3].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))
    const { initial, rounds } = await runShuffleChain(p, agg, seats)
    const ok = await verifyShuffleChain(p, agg, initial, rounds, seats.slice(0, 3).map((s) => s.addr))
    expect(ok).toBe(false)
  })
})

describe('hiding property — one honest shuffler suffices', () => {
  it('re-running a seat shuffle with fresh randomness changes the final order but still round-trips', async () => {
    const p = new AttestedElGamalDeck()
    const seats = await Promise.all([0, 1, 2].map(() => mkSeat(p)))
    const agg = jointKey(p, seats.map((s) => s.pub))

    const a = await runShuffleChain(p, agg, seats)
    const b = await runShuffleChain(p, agg, seats)

    // Two independent runs of the same seats over the same agg produce different
    // decks: the order is determined by the (secret) permutation+remask randomness
    // of EVERY shuffler. Knowing seats {0,2} alone cannot pin seat 1's contribution.
    expect(deckDigest(a.finalDeck)).not.toEqual(deckDigest(b.finalDeck))

    // ...yet both still decrypt to the full 52-card multiset.
    for (const { finalDeck } of [a, b]) {
      const out: number[] = []
      for (let slot = 0; slot < 52; slot++) {
        const shares = []
        for (const s of seats) shares.push(await p.share(s.secret, finalDeck[slot]!, `h/${slot}`))
        out.push(p.unmask(finalDeck[slot]!, shares))
      }
      expect([...out].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i))
    }
  })
})
