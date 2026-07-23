import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes, hexToBigInt, type Hex } from 'viem'

// secp256k1.Point is the WeierstrassPointCons in v1.x (ProjectivePoint is deprecated alias)
export type Point = ReturnType<typeof secp256k1.Point.fromHex>
const Pt = secp256k1.Point
export const G: Point = Pt.BASE
export const ORDER: bigint = Pt.Fn.ORDER

export interface MaskedCard { c1: Point; c2: Point }

export function randomScalar(): bigint {
  return Pt.Fn.fromBytes(secp256k1.utils.randomSecretKey())
}

export function pubKeyOf(sk: bigint): Point { return G.multiply(sk) }

export function aggregatePubKeys(pks: Point[]): Point {
  if (pks.length === 0) throw new Error('aggregatePubKeys: need at least one key')
  // Use pks[0] as seed so we never touch ZERO (ZERO.toHex throws in noble)
  return pks.slice(1).reduce((acc, p) => acc.add(p), pks[0]!)
}

/** card i ↦ G·(i+1); +1 keeps the identity out of the table */
export function cardPoint(i: number): Point { return G.multiply(BigInt(i + 1)) }
const CARD_TABLE: string[] = Array.from({ length: 52 }, (_, i) => cardPoint(i).toHex(true))

export function maskCard(agg: Point, cardIndex: number, r: bigint = randomScalar()): MaskedCard {
  return { c1: G.multiply(r), c2: cardPoint(cardIndex).add(agg.multiply(r)) }
}

export function remask(agg: Point, m: MaskedCard, r: bigint = randomScalar()): MaskedCard {
  return { c1: m.c1.add(G.multiply(r)), c2: m.c2.add(agg.multiply(r)) }
}

/** party's partial decryption: d = c1 · sk */
export function decryptionShare(sk: bigint, m: MaskedCard): Point { return m.c1.multiply(sk) }

/** M = c2 − Σ shares; decode against the 52-entry table */
export function unmaskWithShares(m: MaskedCard, shares: Point[]): number {
  const M = shares.reduce((acc, d) => acc.subtract(d), m.c2)
  const idx = CARD_TABLE.indexOf(M.toHex(true))
  if (idx === -1) throw new Error('unmask: result is not a card point (missing/garbage share?)')
  return idx
}

export function serializePoint(p: Point): Hex { return `0x${p.toHex(true)}` }
export function deserializePoint(h: Hex): Point { return Pt.fromHex(h.slice(2)) }

export function serializeScalar(s: bigint): Hex {
  return bytesToHex(hexToBytes(`0x${s.toString(16).padStart(64, '0')}`))
}

export function deserializeScalar(h: Hex): bigint { return hexToBigInt(h) }

export function serializeMasked(m: MaskedCard): { c1: Hex; c2: Hex } {
  return { c1: serializePoint(m.c1), c2: serializePoint(m.c2) }
}

export function deserializeMasked(w: { c1: Hex; c2: Hex }): MaskedCard {
  return { c1: deserializePoint(w.c1), c2: deserializePoint(w.c2) }
}
