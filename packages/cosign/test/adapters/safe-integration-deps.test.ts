import { describe, expect, it } from 'vitest'
import { keccak256 } from 'viem'
import { getSafeSingletonDeployment, getProxyFactoryDeployment } from '@safe-global/safe-deployments'
import { createRequire } from 'node:module'

// Bytecode source: @safe-global/safe-contracts ships the canonical v1.4.1 hardhat
// artifacts (with deployedBytecode). @safe-global/safe-deployments (>=1.33) no longer
// ships deployedBytecode — only the canonical address + codeHash — so we source the
// runtime bytecode from safe-contracts and assert it hashes to the canonical codeHash.
const require = createRequire(import.meta.url)
const SafeArtifact = require('@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json')

describe('safe-deployments v1.4.1 artifacts', () => {
  it('ships singleton + proxy factory artifacts (canonical address)', () => {
    const singleton = getSafeSingletonDeployment({ version: '1.4.1' })
    const factory = getProxyFactoryDeployment({ version: '1.4.1' })
    expect(singleton).toBeTruthy()
    expect(factory).toBeTruthy()
    // canonical singleton address (mainnet/PulseChain-369/etc.)
    expect(singleton!.defaultAddress).toBe('0x41675C099F32341bf84BFc5382aF534df5C7461a')
  })

  it('safe-contracts deployed bytecode hashes to the canonical on-chain codeHash', () => {
    const singleton = getSafeSingletonDeployment({ version: '1.4.1' })!
    // codeHash of the audited canonical singleton bytecode (== keccak of on-chain runtime code).
    const canonicalCodeHash = (singleton.deployments as { canonical: { codeHash: string } }).canonical.codeHash
    expect(SafeArtifact.deployedBytecode).toMatch(/^0x[0-9a-f]+$/)
    expect(keccak256(SafeArtifact.deployedBytecode).toLowerCase()).toBe(canonicalCodeHash.toLowerCase())
  })
})
