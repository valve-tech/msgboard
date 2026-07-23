import { describe, it, expect } from 'vitest'
import { keccak256, stringToHex, concatHex, type Hex } from 'viem'
import {
  G, ORDER, maskCard, decryptionShare, pubKeyOf, aggregatePubKeys,
  serializePoint, deserializePoint,
} from '../src/elgamal'
import { proveShare, verifyShare } from '../src/chaumPedersen'

/**
 * TS mirror of the on-chain SHARE-dispute verifier (RevealShareDLEQ.sol) and deck-commitment
 * (HoldemTableN._deckHash). Pins BOTH sides to the same secp256k1 DLEQ equations + encoding,
 * so a divergence in the Solidity port (which closes real-money Gate 1) is caught off-chain
 * too, without needing a chain. The actual cross-impl parity to live Solidity is in
 * packages/contracts/test/foundry/{RevealShareDLEQ,HoldemShareDispute}.t.sol.
 */

// Exact replica of chaumPedersen.ts#challenge (internal there) — the on-chain Fiat–Shamir.
function challenge(pk: ReturnType<typeof pubKeyOf>, m: { c1: any; c2: any }, d: any, t1: any, t2: any, ctx: string): bigint {
  const h = keccak256(concatHex([
    stringToHex('zk-cards/chaum-pedersen/v1'),
    serializePoint(pk), serializePoint(m.c1), serializePoint(m.c2),
    serializePoint(d), serializePoint(t1), serializePoint(t2),
    keccak256(stringToHex(ctx)),
  ]))
  return BigInt(h) % ORDER
}

function deckCommitment(deck: { c1: Hex; c2: Hex }[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

const ctxFor = (tableId: Hex, slot: number) => `holdem/${tableId}/slot/${slot}`

describe('on-chain share-dispute DLEQ (TS mirror)', () => {
  const n = 3
  const sks = Array.from({ length: n }, (_, i) => (BigInt(i + 1) * 0x9e3779b97f4a7c15n) % ORDER)
  const pks = sks.map(pubKeyOf)
  const agg = aggregatePubKeys(pks)
  const deck = Array.from({ length: 52 }, (_, i) => maskCard(agg, i, (BigInt(i) * 7n + 3n) % ORDER))
  const tableId = ('0x' + '00'.repeat(31) + '07') as Hex
  const slot = 4
  const seat = 2
  const m = deck[slot]!
  const d = decryptionShare(sks[seat]!, m)
  const ctx = ctxFor(tableId, slot)
  const proof = proveShare(sks[seat]!, m, ctx)
  const t1 = deserializePoint(proof.t1)
  const t2 = deserializePoint(proof.t2)
  const z = BigInt(proof.z)

  it('off-chain soundness: the share verifies', () => {
    expect(verifyShare(pks[seat]!, m, d, proof, ctx)).toBe(true)
  })

  it('the two on-chain DLEQ equations hold: G·z==t1+pk·e and c1·z==t2+d·e', () => {
    const e = challenge(pks[seat]!, m, d, t1, t2, ctx)
    // eq1
    expect(G.multiply(z).equals(t1.add(pks[seat]!.multiply(e)))).toBe(true)
    // eq2
    expect(m.c1.multiply(z).equals(t2.add(d.multiply(e)))).toBe(true)
  })

  it('a forged z breaks eq1 (what BadShareProof catches on-chain)', () => {
    const e = challenge(pks[seat]!, m, d, t1, t2, ctx)
    const zBad = (z + 1n) % ORDER
    expect(G.multiply(zBad).equals(t1.add(pks[seat]!.multiply(e)))).toBe(false)
  })

  it('deckCommitment is the keccak of compressed (c1,c2) wire points (mirrors _deckHash)', () => {
    const wire = deck.map((c) => ({ c1: serializePoint(c.c1), c2: serializePoint(c.c2) }))
    const commit = deckCommitment(wire)
    expect(commit).toMatch(/^0x[0-9a-f]{64}$/)
    // re-hashing the same deck is stable (binding) and order-sensitive
    expect(deckCommitment(wire)).toBe(commit)
    const swapped = [...wire]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(deckCommitment(swapped)).not.toBe(commit)
  })
})
