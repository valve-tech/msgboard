import { describe, it, expect } from 'vitest'
import {
  randomScalar, pubKeyOf, aggregatePubKeys, maskCard, remask,
  decryptionShare, unmaskWithShares, serializePoint, deserializePoint,
} from '../src/elgamal'

describe('elgamal masking', () => {
  const skA = randomScalar(), skB = randomScalar()
  const agg = aggregatePubKeys([pubKeyOf(skA), pubKeyOf(skB)])

  it('mask → both shares → unmask round-trips every card', () => {
    for (const i of [0, 7, 51]) {
      const m = maskCard(agg, i)
      const shares = [decryptionShare(skA, m), decryptionShare(skB, m)]
      expect(unmaskWithShares(m, shares)).toBe(i)
    }
  })
  it('remask preserves the plaintext but changes the ciphertext', () => {
    const m = maskCard(agg, 13)
    const r = remask(agg, m)
    expect(serializePoint(r.c1)).not.toBe(serializePoint(m.c1))
    const shares = [decryptionShare(skA, r), decryptionShare(skB, r)]
    expect(unmaskWithShares(r, shares)).toBe(13)
  })
  it('one share is not enough', () => {
    const m = maskCard(agg, 3)
    expect(() => unmaskWithShares(m, [decryptionShare(skA, m)])).toThrow(/not a card point/)
  })
  it('points serialize round-trip', () => {
    const p = pubKeyOf(skA)
    expect(serializePoint(deserializePoint(serializePoint(p)))).toBe(serializePoint(p))
  })
})
