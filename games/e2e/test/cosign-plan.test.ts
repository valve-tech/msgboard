import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import {
  buildSetup,
  predictSafeAddress,
  deterministicSaltNonce,
  benignSelfCall,
  deployRequestDigest,
  solveDeployPow,
  verifyDeployPow,
  foldSession,
  SAFE_V141,
} from '../scripts/cosign-plan'

// Fixed fixtures below are the SAME references the web app's deploy-safe.test.ts locks to (fetched
// from the real 369/943 v1.4.1 factory), so this proves the replicated constants are byte-correct.
const A = '0x1111111111111111111111111111111111111111' as Hex
const B = '0x2222222222222222222222222222222222222222' as Hex
const C = '0x3333333333333333333333333333333333333333' as Hex

describe('buildSetup', () => {
  it('encodes the exact v1.4.1 setup initializer (fixed fixture)', () => {
    const expected =
      '0xb63e800d0000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000160000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec990000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000111111111111111111111111111111111111111100000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000'
    expect(buildSetup([A, B], 1)).toBe(expected)
  })

  it('exposes the canonical v1.4.1 fallback handler', () => {
    expect(SAFE_V141.fallbackHandler).toBe('0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99')
  })
})

describe('predictSafeAddress', () => {
  it('matches the reference CREATE2 address for the fixed fixture (saltNonce 0)', () => {
    expect(predictSafeAddress({ owners: [A, B], threshold: 1, saltNonce: 0n })).toBe(
      '0xf4065759F44c99b596448F58F59249a8C13F819C',
    )
  })

  it('changes with the saltNonce', () => {
    const base = { owners: [A], threshold: 1 }
    expect(predictSafeAddress({ ...base, saltNonce: 0n })).not.toBe(predictSafeAddress({ ...base, saltNonce: 1n }))
  })
})

describe('deterministicSaltNonce', () => {
  it('is stable across calls (restart-safe)', () => {
    expect(deterministicSaltNonce(943, [A, B, C], 2)).toBe(deterministicSaltNonce(943, [A, B, C], 2))
  })

  it('is case-insensitive in the owner set', () => {
    expect(deterministicSaltNonce(943, [A, B, C], 2)).toBe(
      deterministicSaltNonce(943, [A.toUpperCase() as Hex, B, C], 2),
    )
  })

  it('differs by chain, owner set, and threshold', () => {
    const base = deterministicSaltNonce(943, [A, B, C], 2)
    expect(deterministicSaltNonce(369, [A, B, C], 2)).not.toBe(base)
    expect(deterministicSaltNonce(943, [A, B], 2)).not.toBe(base)
    expect(deterministicSaltNonce(943, [A, B, C], 1)).not.toBe(base)
  })

  it('yields a stable predicted address across restarts', () => {
    const salt = deterministicSaltNonce(943, [A, B, C], 2)
    expect(predictSafeAddress({ owners: [A, B, C], threshold: 2, saltNonce: salt })).toBe(
      predictSafeAddress({ owners: [A, B, C], threshold: 2, saltNonce: salt }),
    )
  })
})

describe('benignSelfCall', () => {
  it('is a zero-value self-call at the given nonce (moves nothing, always executable)', () => {
    const tx = benignSelfCall(B, 7n)
    expect(tx.to).toBe(B)
    expect(tx.value).toBe(0n)
    expect(tx.data).toBe('0x')
    expect(tx.operation).toBe(0)
    expect(tx.nonce).toBe(7n)
    expect(tx.gasToken).toBe('0x0000000000000000000000000000000000000000')
    expect(tx.refundReceiver).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('relay deploy PoW', () => {
  const digest = deployRequestDigest({
    chainId: 943,
    singleton: SAFE_V141.singletonL2,
    initializer: buildSetup([A, B, C], 2),
    saltNonce: 42n,
  })

  it('deployRequestDigest is deterministic and binds its inputs', () => {
    expect(digest).toBe(
      deployRequestDigest({
        chainId: 943,
        singleton: SAFE_V141.singletonL2,
        initializer: buildSetup([A, B, C], 2),
        saltNonce: 42n,
      }),
    )
    const other = deployRequestDigest({
      chainId: 369,
      singleton: SAFE_V141.singletonL2,
      initializer: buildSetup([A, B, C], 2),
      saltNonce: 42n,
    })
    expect(other).not.toBe(digest)
  })

  it('solveDeployPow produces a nonce that verifies at the same difficulty', async () => {
    const bits = 8 // small: fast + deterministic enough for a unit test
    const nonce = await solveDeployPow(digest, bits)
    expect(verifyDeployPow(digest, nonce, bits)).toBe(true)
  })
})

describe('foldSession', () => {
  const owners = [A, B, C]

  it('counts only owner signers, deduped, and meets the threshold', () => {
    const fold = foldSession([A, B], owners, 2)
    expect(fold.signedOwners).toEqual([A, B])
    expect(fold.thresholdMet).toBe(true)
  })

  it('ignores non-owners and nulls, and dedupes a repeat signer', () => {
    const fold = foldSession([A, A, '0x9999999999999999999999999999999999999999' as Hex, null], owners, 2)
    expect(fold.signedOwners).toEqual([A])
    expect(fold.thresholdMet).toBe(false)
  })

  it('reports threshold unmet with a single signer', () => {
    expect(foldSession([C], owners, 2).thresholdMet).toBe(false)
  })
})
