import { keccak256, concatHex, recoverMessageAddress, type Hex } from 'viem'
import type { MaskedDeckProvider, ShuffleSigner, WireMasked, WireShare, WireShuffle } from './maskedDeck'
import {
  randomScalar, pubKeyOf, aggregatePubKeys, maskCard, remask, decryptionShare,
  unmaskWithShares, serializePoint, deserializePoint, serializeScalar, deserializeScalar,
  deserializeMasked, serializeMasked,
} from './elgamal'
import { proveShare, verifyShare as cpVerify, type ShareProof } from './chaumPedersen'
import { DECK_SIZE } from './cards'

function deckDigest(deck: WireMasked[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}
function shuffleDigest(before: WireMasked[], after: WireMasked[]): Hex {
  return keccak256(concatHex([deckDigest(before), deckDigest(after)]))
}

/**
 * v0 deck provider. Hiding and share soundness are REAL (ElGamal + Chaum–Pedersen).
 * The shuffle proof is only the shuffler's signature over keccak(before||after):
 * integrity is attested, not zero-knowledge-proven. The SNARK provider from the
 * SDK spike replaces exactly this behind MaskedDeckProvider.
 */
export class AttestedElGamalDeck implements MaskedDeckProvider {
  async keygen() {
    const sk = randomScalar()
    return { secret: serializeScalar(sk), pub: serializePoint(pubKeyOf(sk)) }
  }
  aggregate(pubs: Hex[]): Hex {
    return serializePoint(aggregatePubKeys(pubs.map(deserializePoint)))
  }
  async initialDeck(agg: Hex): Promise<WireMasked[]> {
    const A = deserializePoint(agg)
    return Array.from({ length: DECK_SIZE }, (_, i) => serializeMasked(maskCard(A, i)))
  }
  async shuffle(agg: Hex, deck: WireMasked[], signer: ShuffleSigner): Promise<WireShuffle> {
    const A = deserializePoint(agg)
    const out = deck.map((w) => serializeMasked(remask(A, deserializeMasked(w))))
    // Fisher–Yates with crypto-quality randomness; 256-bit scalar mod ≤52 bias is negligible
    for (let i = out.length - 1; i > 0; i--) {
      const j = Number(randomScalar() % BigInt(i + 1))
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    const proof = await signer.signMessage({ message: { raw: shuffleDigest(deck, out) } })
    return { deck: out, proof }
  }
  // v0: agg is not cryptographically bound to the shuffle proof; the signature
  // only attests deck-before/after integrity. The SNARK provider will enforce
  // agg-binding via the shuffle argument.
  async verifyShuffle(_agg: Hex, before: WireMasked[], after: WireShuffle, signerAddr: Hex): Promise<boolean> {
    if (after.deck.length !== before.length) return false
    try {
      const rec = await recoverMessageAddress({
        message: { raw: shuffleDigest(before, after.deck) },
        signature: after.proof as Hex,
      })
      return rec.toLowerCase() === signerAddr.toLowerCase()
    } catch { return false }
  }
  async share(secret: Hex, card: WireMasked, ctx: string): Promise<WireShare> {
    const sk = deserializeScalar(secret)
    const m = deserializeMasked(card)
    return { share: serializePoint(decryptionShare(sk, m)), proof: proveShare(sk, m, ctx) }
  }
  async verifyShare(pub: Hex, card: WireMasked, s: WireShare, ctx: string): Promise<boolean> {
    try {
      return cpVerify(
        deserializePoint(pub), deserializeMasked(card),
        deserializePoint(s.share), s.proof as ShareProof, ctx,
      )
    } catch { return false }
  }
  unmask(card: WireMasked, shares: WireShare[]): number {
    return unmaskWithShares(deserializeMasked(card), shares.map((s) => deserializePoint(s.share)))
  }
}
