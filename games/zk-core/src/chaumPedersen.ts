import { keccak256, stringToHex, concatHex, type Hex } from 'viem'
import {
  G, ORDER, randomScalar, type Point, type MaskedCard,
  serializePoint, deserializePoint, serializeScalar, deserializeScalar,
} from './elgamal'

export interface ShareProof { t1: Hex; t2: Hex; z: Hex }

function challenge(pk: Point, m: MaskedCard, d: Point, t1: Point, t2: Point, ctx: string): bigint {
  const h = keccak256(concatHex([
    stringToHex('zk-cards/chaum-pedersen/v1'),
    serializePoint(pk), serializePoint(m.c1), serializePoint(m.c2),
    serializePoint(d), serializePoint(t1), serializePoint(t2),
    // ctx is hashed to fixed width so the transcript encoding is unambiguous
    keccak256(stringToHex(ctx)),
  ]))
  return BigInt(h) % ORDER
}

/** prove d = c1·sk for pk = G·sk, bound to ctx */
export function proveShare(sk: bigint, m: MaskedCard, ctx: string): ShareProof {
  const w = randomScalar() // fresh nonce per proof; never reuse w across proofs
  const t1 = G.multiply(w)
  const t2 = m.c1.multiply(w)
  const d = m.c1.multiply(sk)
  const e = challenge(G.multiply(sk), m, d, t1, t2, ctx)
  const z = (w + e * sk) % ORDER
  return { t1: serializePoint(t1), t2: serializePoint(t2), z: serializeScalar(z) }
}

export function verifyShare(pk: Point, m: MaskedCard, d: Point, proof: ShareProof, ctx: string): boolean {
  try {
    const t1 = deserializePoint(proof.t1), t2 = deserializePoint(proof.t2)
    const z = deserializeScalar(proof.z)
    const e = challenge(pk, m, d, t1, t2, ctx)
    const left1 = G.multiply(z), right1 = t1.add(pk.multiply(e))
    const left2 = m.c1.multiply(z), right2 = t2.add(d.multiply(e))
    return left1.equals(right1) && left2.equals(right2)
  } catch { return false }
}
