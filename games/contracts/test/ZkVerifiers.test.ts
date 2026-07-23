import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
// joint and revealSample keys are unused here but retained because the fixture is a
// byte-exact provenance artifact from the pinned wasm.
import shuffleFixture from './fixtures/zypher-shuffle-head.json'
import revealFixture from './fixtures/zypher-reveal-snark.json'
import { revertedWithCustomError } from './expectations'

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    __SOLIDITY_COVERAGE_RUNNING: boolean
  }
}

// Flatten a 52-card deck (each card is 4 field elements) into a flat uint256[] array.
// Mirrors the spike bench: `deck.flat().map(BigInt)`.
const flatDeck = (deck: string[][]): bigint[] => deck.flat().map((v) => BigInt(v))

// Place a contract's compiled runtime bytecode directly at `address` via hardhat_setCode.
// The vendored VerifierKeyExtra*_52 contracts (~85KB) and RevealVerifier (~30KB) exceed
// EIP-170's 24576-byte deployed-code limit (and EIP-3860's init-code limit), so they cannot
// be deployed by a normal tx under the default network (allowUnlimitedContractSize:false).
// setCode writes runtime code directly, bypassing both checks, so these tests run under plain
// `hardhat test` without relaxing the global size limit (which the Random suite depends on
// staying enforced). Under solidity-coverage the size limit is off and contracts must be
// deployed so they are instrumented, so the callers branch on __SOLIDITY_COVERAGE_RUNNING.
const etch = async (artifactName: string, address: viem.Hex) => {
  const artifact = await hre.artifacts.readArtifact(artifactName)
  const testClient = await hre.viem.getTestClient()
  await testClient.setCode({ address, bytecode: artifact.deployedBytecode as viem.Hex })
}

// Fixed arbitrary addresses for the etched verifier runtime code (non-coverage path).
const VK1_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce521')
const VK2_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce522')
const REVEAL_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce523')

// Returns a ShuffleVerifier52 wired to the verifier keys. Under coverage the keys are deployed
// (size limit off, instrumentation intact); otherwise their oversized runtime code is etched.
const deployOrEtchShuffler = async () => {
  if (hre.__SOLIDITY_COVERAGE_RUNNING) {
    const vk1 = await hre.viem.deployContract('VerifierKeyExtra1_52')
    const vk2 = await hre.viem.deployContract('VerifierKeyExtra2_52')
    return await hre.viem.deployContract('ShuffleVerifier52', [vk1.address, vk2.address])
  }
  await etch('VerifierKeyExtra1_52', VK1_ADDR)
  await etch('VerifierKeyExtra2_52', VK2_ADDR)
  return await hre.viem.deployContract('ShuffleVerifier52', [VK1_ADDR, VK2_ADDR])
}

// Returns a typed RevealVerifier handle. Under coverage it is deployed (instrumented); otherwise
// its oversized runtime code is etched at a fixed address.
const deployOrEtchRevealVerifier = async () => {
  if (hre.__SOLIDITY_COVERAGE_RUNNING) {
    return await hre.viem.deployContract('RevealVerifier')
  }
  await etch('RevealVerifier', REVEAL_ADDR)
  return await hre.viem.getContractAt('RevealVerifier', REVEAL_ADDR)
}

describe('ZkVerifiers', () => {
  it('verify52: accepts a real spike-generated shuffle proof', async () => {
    const shuffler = await deployOrEtchShuffler()

    const pi: bigint[] = [...flatDeck(shuffleFixture.before), ...flatDeck(shuffleFixture.after)]
    const pkc: bigint[] = shuffleFixture.pkc.map((v) => BigInt(v))
    const proof = shuffleFixture.proof as `0x${string}`

    const publicClient = await hre.viem.getPublicClient()
    const { result } = await publicClient.simulateContract({
      address: shuffler.address,
      abi: shuffler.abi,
      functionName: 'verify52',
      args: [proof, pi, pkc],
      gas: 30_000_000n,
    })
    expect(result).to.equal(true)
  })

  it('verify52: rejects a tampered proof', async () => {
    const shuffler = await deployOrEtchShuffler()

    const pi: bigint[] = [...flatDeck(shuffleFixture.before), ...flatDeck(shuffleFixture.after)]
    const pkc: bigint[] = shuffleFixture.pkc.map((v) => BigInt(v))
    // Flip the last byte of the proof to invalidate it.
    const good = shuffleFixture.proof
    const tampered = (good.slice(0, -2) + (good.slice(-2) === 'ff' ? '00' : 'ff')) as `0x${string}`

    const publicClient = await hre.viem.getPublicClient()
    await revertedWithCustomError(
      shuffler,
      publicClient.simulateContract({
        address: shuffler.address,
        abi: shuffler.abi,
        functionName: 'verify52',
        args: [tampered, pi, pkc],
        gas: 30_000_000n,
      }),
      'InvalidShuffleProof',
    )
  })

  it('verifyRevealWithSnark: accepts a real Groth16 reveal proof', async () => {
    const reveal = await deployOrEtchRevealVerifier()

    const pi = revealFixture.pi.map((v) => BigInt(v)) as unknown as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    const zkproof = revealFixture.zkproof.map((v) => BigInt(v)) as unknown as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]

    const ok = await reveal.read.verifyRevealWithSnark([pi, zkproof])
    expect(ok).to.equal(true)
  })
})
