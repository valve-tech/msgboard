import { describe, expect, it } from 'vitest'
import { toHex } from 'viem'
import { powHash, powTarget, solvePow, verifyPow } from '../src/pow.js'

const DIGEST = '0x1111111111111111111111111111111111111111111111111111111111111a' as const

describe('powTarget', () => {
  it('halves for each additional bit of difficulty', () => {
    expect(powTarget(1)).toBe(powTarget(0) / 2n)
    expect(powTarget(8)).toBe(powTarget(0) / 256n)
  })

  it('bit 0 is the full 256-bit space', () => {
    expect(powTarget(0)).toBe(2n ** 256n)
  })
})

describe('solvePow + verifyPow', () => {
  it('a solved nonce passes verification at the same difficulty', () => {
    const nonce = solvePow(DIGEST, 10)
    expect(verifyPow(DIGEST, nonce, 10)).toBe(true)
  })

  it('a random wrong nonce fails at a reasonable difficulty', () => {
    expect(verifyPow(DIGEST, toHex(0n, { size: 32 }), 20)).toBe(false)
  })

  it('a nonce solved for low difficulty overwhelmingly fails a much stricter check', () => {
    const nonce = solvePow(DIGEST, 8)
    expect(verifyPow(DIGEST, nonce, 24)).toBe(false)
  })

  it('is sensitive to the digest (same nonce, different digest, does not generally verify)', () => {
    const nonce = solvePow(DIGEST, 16)
    const otherDigest = '0x2222222222222222222222222222222222222222222222222222222222222b' as const
    expect(verifyPow(otherDigest, nonce, 16)).toBe(false)
  })
})

describe('powHash', () => {
  it('is deterministic for the same digest + nonce', () => {
    const nonce = toHex(42n, { size: 32 })
    expect(powHash(DIGEST, nonce)).toBe(powHash(DIGEST, nonce))
  })

  it('changes when the nonce changes', () => {
    expect(powHash(DIGEST, toHex(1n, { size: 32 }))).not.toBe(powHash(DIGEST, toHex(2n, { size: 32 })))
  })
})
