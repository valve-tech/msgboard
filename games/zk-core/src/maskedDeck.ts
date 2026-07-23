import type { Hex } from 'viem'

export interface WireMasked { c1: Hex; c2: Hex }
export interface WireShare { share: Hex; proof: unknown }
export interface WireShuffle { deck: WireMasked[]; proof: unknown }

/**
 * The crypto seam. v0 = AttestedElGamalDeck (real hiding + share soundness,
 * signature-attested shuffles). The SNARK SDK from the spike replaces it with
 * ZK shuffle arguments behind this same interface.
 */
export interface MaskedDeckProvider {
  /** party key for the deck crypto (NOT the wallet key) */
  keygen(): Promise<{ secret: Hex; pub: Hex }>
  aggregate(pubs: Hex[]): Hex
  /** canonical 52-card deck masked under agg, order 0..51 */
  initialDeck(agg: Hex): Promise<WireMasked[]>
  /** permute + remask; proof must convince verifyShuffle */
  shuffle(agg: Hex, deck: WireMasked[], signer: ShuffleSigner): Promise<WireShuffle>
  verifyShuffle(agg: Hex, before: WireMasked[], after: WireShuffle, signerAddr: Hex): Promise<boolean>
  /** decryption share for one slot, ctx binds table+slot against replay */
  share(secret: Hex, card: WireMasked, ctx: string): Promise<WireShare>
  verifyShare(pub: Hex, card: WireMasked, s: WireShare, ctx: string): Promise<boolean>
  /** decode with all parties' shares */
  unmask(card: WireMasked, shares: WireShare[]): number
}

export interface ShuffleSigner {
  address: Hex
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>
}
