import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  AttestedElGamalDeck,
  Transcript,
  verifyShare,
  deserializePoint,
  deserializeMasked,
  unmaskWithShares,
  serializePoint,
  serializeScalar,
  type ShareProof,
} from '@msgboard/zk-cards-core'
import { jointKey, runShuffleChain } from '../src/deckN'
import { dealPlan, runDeal, type DealBoard } from '../src/dealSeq'
import { ctxFor } from '../src/revealN'
import {
  requiredShowdownSlots,
  generateShowdownReveals,
  encodeDeckForShowdown,
  type ShowdownRevealBatch,
} from '../src/showdownReveal'

// ---- helpers (mirrors dealSeq.test.ts) -------------------------------------

const mkSeat = async (p: AttestedElGamalDeck) => {
  const k = await p.keygen()
  const acct = privateKeyToAccount(generatePrivateKey())
  return { ...k, addr: acct.address, signer: acct }
}

const randTableId = (): Hex =>
  ('0x' +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Hex

function fakeBoard(tableId: Hex): DealBoard {
  const transcript = new Transcript(tableId)
  return { transcript, stamp() {} }
}

async function setupDealtTable(n: number) {
  const p = new AttestedElGamalDeck()
  const seats = await Promise.all(Array.from({ length: n }, () => mkSeat(p)))
  const agg = jointKey(p, seats.map((s) => s.pub))
  const tableId = randTableId()
  const { finalDeck, rounds } = await runShuffleChain(p, agg, seats)
  const board = fakeBoard(tableId)
  const plan = dealPlan(n)
  const deal = await runDeal({
    provider: p,
    seats,
    agg,
    tableId,
    deck: finalDeck,
    rounds,
    plan,
    board,
    verifyAllShares: true,
  })
  return { p, seats, agg, tableId, finalDeck, plan, deal }
}

// ---- tests ------------------------------------------------------------------

describe('requiredShowdownSlots', () => {
  it('N=3, seats 0 and 2 live (seat 1 folded): holes for live seats + full board, seat 1 excluded', () => {
    const slots = requiredShowdownSlots(3, 0b101) // bits 0 and 2 set
    // holes: seat0 -> [0,3], seat2 -> [2,5]; board -> [6,7,8,9,10]
    expect(slots).toEqual([0, 2, 3, 5, 6, 7, 8, 9, 10])
  })

  it('single live seat -> stub, no required slots at all', () => {
    expect(requiredShowdownSlots(4, 0b0010)).toEqual([])
  })

  it('zero live seats -> stub (defensive), no required slots', () => {
    expect(requiredShowdownSlots(4, 0)).toEqual([])
  })

  it('all seats live, N=2 -> the full dealt set, 2N+5=9 slots, matches dealPlan', () => {
    const plan = dealPlan(2)
    const expected = [...plan.holeSlots.flat(), ...plan.flop, plan.turn, plan.river].sort((a, b) => a - b)
    expect(requiredShowdownSlots(2, 0b11)).toEqual(expected)
  })
})

describe('generateShowdownReveals — shape + real DLEQ verification + decode round-trip', () => {
  for (const n of [2, 3]) {
    it(`N=${n}: every generated (share, proof) verifies under chaumPedersen.verifyShare (mirror of the on-chain DLEQ)`, async () => {
      const { seats, tableId, finalDeck, plan } = await setupDealtTable(n)
      const allLive = (1 << n) - 1
      const slots = requiredShowdownSlots(n, allLive)
      expect(slots).toEqual([...plan.holeSlots.flat(), ...plan.flop, plan.turn, plan.river].sort((a, b) => a - b))

      const batches: ShowdownRevealBatch[] = seats.map((s) =>
        generateShowdownReveals({ tableId, secret: s.secret, deck: finalDeck, slots }),
      )

      for (let si = 0; si < n; si++) {
        const batch = batches[si]!
        expect(batch.slots).toEqual(slots)
        expect(batch.shares.length).toBe(slots.length)
        expect(batch.proofs.length).toBe(slots.length)

        for (let i = 0; i < batch.slots.length; i++) {
          const slot = batch.slots[i]!
          const m = deserializeMasked(finalDeck[slot]!)
          const d = secp256k1.Point.fromAffine({ x: batch.shares[i]![0], y: batch.shares[i]![1] })
          const proof: ShareProof = {
            t1: serializePoint(secp256k1.Point.fromAffine({ x: batch.proofs[i]![0], y: batch.proofs[i]![1] })),
            t2: serializePoint(secp256k1.Point.fromAffine({ x: batch.proofs[i]![2], y: batch.proofs[i]![3] })),
            z: serializeScalar(batch.proofs[i]![4]),
          }
          const ok = verifyShare(deserializePoint(seats[si]!.pub), m, d, proof, ctxFor(tableId, slot))
          expect(ok).toBe(true)
        }
      }
    })

    it(`N=${n}: combining all N seats' generated shares decodes each slot to the REAL dealt card`, async () => {
      const { seats, tableId, finalDeck, plan, deal } = await setupDealtTable(n)
      const allLive = (1 << n) - 1
      const slots = requiredShowdownSlots(n, allLive)
      const batches: ShowdownRevealBatch[] = seats.map((s) =>
        generateShowdownReveals({ tableId, secret: s.secret, deck: finalDeck, slots }),
      )

      const expectedCard = (slot: number): number => {
        for (let s = 0; s < n; s++) {
          if (slot === plan.holeSlots[s]![0]) return deal.holeCards[s]![0]!
          if (slot === plan.holeSlots[s]![1]) return deal.holeCards[s]![1]!
        }
        const flopIdx = plan.flop.indexOf(slot)
        if (flopIdx !== -1) return deal.community[flopIdx]!
        if (slot === plan.turn) return deal.community[3]!
        if (slot === plan.river) return deal.community[4]!
        throw new Error(`slot ${slot} not in the dealt set`)
      }

      for (const slot of slots) {
        const points = batches.map((b) => {
          const i = b.slots.indexOf(slot)
          return secp256k1.Point.fromAffine({ x: b.shares[i]![0], y: b.shares[i]![1] })
        })
        const card = unmaskWithShares(deserializeMasked(finalDeck[slot]!), points)
        expect(card).toBe(expectedCard(slot))
      }
    })
  }

  it('deduplicates and sorts requested slots', async () => {
    const { seats, tableId, finalDeck } = await setupDealtTable(2)
    const batch = generateShowdownReveals({
      tableId,
      secret: seats[0]!.secret,
      deck: finalDeck,
      slots: [3, 0, 3, 1],
    })
    expect(batch.slots).toEqual([0, 1, 3])
    expect(batch.shares.length).toBe(3)
    expect(batch.proofs.length).toBe(3)
  })

  it('throws on an out-of-range slot', async () => {
    const { seats, tableId, finalDeck } = await setupDealtTable(2)
    expect(() =>
      generateShowdownReveals({ tableId, secret: seats[0]!.secret, deck: finalDeck, slots: [999] }),
    ).toThrow(/no slot 999/)
  })
})

describe('encodeDeckForShowdown', () => {
  it('round-trips affine coordinates for every card, 4 words per card', async () => {
    const p = new AttestedElGamalDeck()
    const { pub } = await p.keygen()
    const deck = await p.initialDeck(pub)
    const words = encodeDeckForShowdown(deck)
    expect(words.length).toBe(deck.length * 4)

    const c1 = deserializePoint(deck[0]!.c1).toAffine()
    const c2 = deserializePoint(deck[0]!.c2).toAffine()
    expect(words[0]).toBe(c1.x)
    expect(words[1]).toBe(c1.y)
    expect(words[2]).toBe(c2.x)
    expect(words[3]).toBe(c2.y)
  })
})
