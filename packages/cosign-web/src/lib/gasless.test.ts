import { describe, expect, it } from 'vitest'
import { type Hex, encodeAbiParameters, keccak256, toHex } from 'viem'
import { SAFE_V141, buildSetup } from './deploy-safe'
import { deployRequestDigest, solveDeployPow, verifyDeployPow } from './gasless'

const OWNER_A = '0x1111111111111111111111111111111111111111' as const
const OWNER_B = '0x2222222222222222222222222222222222222222' as const

describe('deployRequestDigest', () => {
  const initializer = buildSetup([OWNER_A, OWNER_B], 1)

  it('is deterministic for the same inputs', () => {
    const a = deployRequestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    const b = deployRequestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    expect(a).toBe(b)
  })

  it('matches the relay\'s own formula: keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
        [943n, SAFE_V141.singletonL2, keccak256(initializer), 1n],
      ),
    )
    expect(deployRequestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })).toBe(expected)
  })

  it('changes when any input changes', () => {
    const base = deployRequestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })
    expect(deployRequestDigest({ chainId: 369, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 1n })).not.toBe(base)
    expect(deployRequestDigest({ chainId: 943, singleton: SAFE_V141.singletonL2, initializer, saltNonce: 2n })).not.toBe(base)
  })
})

describe('solveDeployPow + verifyDeployPow', () => {
  const digest = '0x1111111111111111111111111111111111111111111111111111111111111a' as const satisfies Hex

  it('a solved nonce passes verification at the same difficulty', async () => {
    const nonce = await solveDeployPow(digest, 10)
    expect(verifyDeployPow(digest, nonce, 10)).toBe(true)
  })

  it('a random wrong nonce fails at a reasonable difficulty', () => {
    expect(verifyDeployPow(digest, toHex(0n, { size: 32 }), 20)).toBe(false)
  })

  it('is sensitive to the digest (same nonce, different digest, does not generally verify)', async () => {
    const nonce = await solveDeployPow(digest, 16)
    const otherDigest = '0x2222222222222222222222222222222222222222222222222222222222222b' as const
    expect(verifyDeployPow(otherDigest, nonce, 16)).toBe(false)
  })
})
