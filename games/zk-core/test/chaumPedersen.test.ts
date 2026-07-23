import { describe, it, expect } from 'vitest'
import { randomScalar, pubKeyOf, maskCard, decryptionShare, aggregatePubKeys } from '../src/elgamal'
import { proveShare, verifyShare } from '../src/chaumPedersen'

describe('chaum-pedersen share proofs', () => {
  const sk = randomScalar(), pk = pubKeyOf(sk)
  const agg = aggregatePubKeys([pk, pubKeyOf(randomScalar())])
  const m = maskCard(agg, 21)
  const d = decryptionShare(sk, m)

  it('honest proof verifies', () => {
    const proof = proveShare(sk, m, 'table-1/slot-4')
    expect(verifyShare(pk, m, d, proof, 'table-1/slot-4')).toBe(true)
  })
  it('rejects a share for the wrong ciphertext', () => {
    const m2 = maskCard(agg, 22)
    const proof = proveShare(sk, m, 'ctx')
    expect(verifyShare(pk, m2, decryptionShare(sk, m), proof, 'ctx')).toBe(false)
  })
  it('rejects a forged share (wrong sk)', () => {
    const skEvil = randomScalar()
    const forged = decryptionShare(skEvil, m)
    const proof = proveShare(skEvil, m, 'ctx')
    expect(verifyShare(pk, m, forged, proof, 'ctx')).toBe(false) // pk doesn't match skEvil
  })
  it('rejects context swap (no cross-slot replay)', () => {
    const proof = proveShare(sk, m, 'slot-4')
    expect(verifyShare(pk, m, d, proof, 'slot-5')).toBe(false)
  })
})
