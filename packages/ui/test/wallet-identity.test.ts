import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { deriveIdentityFromSignature } from '../src/lib/wallet-identity'
import { SNARK_FIELD } from '../src/lib/zk-post'

/**
 * The portable identity is only useful if it is DETERMINISTIC: the same wallet signature must derive
 * the exact same Semaphore identity (and encryption keypair) every time, on any device — that is the
 * whole "re-sign anywhere to restore" property. A different signature must derive a different, in-
 * field identity. (The derivation logic itself is security-critical and separately audited; these
 * tests only pin the consumer-visible contract with fixed hex "signatures" — no real wallet needed.)
 */

// A `personal_sign` result is 65 bytes: r(32) ‖ s(32) ‖ v(1). Two fixed, distinct examples.
const SIG_A =
  ('0x' +
    '11'.repeat(32) + // r
    '22'.repeat(32) + // s
    '1b') as Hex // v
const SIG_B =
  ('0x' +
    '33'.repeat(32) +
    '44'.repeat(32) +
    '1c') as Hex

describe('wallet-identity — deterministic portable derivation', () => {
  it('same signature → identical derived identity (nullifier, trapdoor, encPublicKey)', () => {
    const a = deriveIdentityFromSignature(SIG_A)
    const b = deriveIdentityFromSignature(SIG_A)
    expect(a.identity.nullifier).toBe(b.identity.nullifier)
    expect(a.identity.trapdoor).toBe(b.identity.trapdoor)
    expect(a.encPublicKey).toEqual(b.encPublicKey)
    expect(a.encPrivateKey).toEqual(b.encPrivateKey)
  })

  it('a different signature → a different identity', () => {
    const a = deriveIdentityFromSignature(SIG_A)
    const b = deriveIdentityFromSignature(SIG_B)
    expect(a.identity.nullifier).not.toBe(b.identity.nullifier)
    expect(a.identity.trapdoor).not.toBe(b.identity.trapdoor)
    expect(a.encPublicKey).not.toEqual(b.encPublicKey)
  })

  it('nullifier and trapdoor are domain-separated (distinct within one identity)', () => {
    const a = deriveIdentityFromSignature(SIG_A)
    expect(a.identity.nullifier).not.toBe(a.identity.trapdoor)
  })

  it('derived nullifier/trapdoor are in-field (0 < x < SNARK_FIELD)', () => {
    for (const sig of [SIG_A, SIG_B]) {
      const { identity } = deriveIdentityFromSignature(sig)
      expect(identity.nullifier > 0n).toBe(true)
      expect(identity.nullifier < SNARK_FIELD).toBe(true)
      expect(identity.trapdoor > 0n).toBe(true)
      expect(identity.trapdoor < SNARK_FIELD).toBe(true)
    }
  })

  it('encPublicKey is a 32-byte X25519 key', () => {
    const { encPublicKey } = deriveIdentityFromSignature(SIG_A)
    expect(encPublicKey).toBeInstanceOf(Uint8Array)
    expect(encPublicKey.length).toBe(32)
  })
})
