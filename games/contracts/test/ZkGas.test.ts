import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { makeDomain, signState as coreSignState, type ChannelState, type ChannelDomain } from '@msgboard/zk-cards-core'
import shuffleFixture from './fixtures/zypher-shuffle-head.json'
import revealFixture from './fixtures/zypher-reveal-snark.json'

// Gas-ceiling regression tests.
//
// These assert that the gas of the verifier paths and the ZkTable lifecycle ops stays under
// an explicit ceiling tied to the spike's measured budgets. They are REGRESSION GUARDS: the
// point is to fail loudly if a future change blows the budget, especially on the verifier
// paths that gate on-chain dispute feasibility. Each ceiling sits ~10-30% above the measured
// value (margin for compiler drift); the measured value is recorded in a comment beside it.
//
// Measurement: actual gas is read from transaction receipts (receipt.gasUsed) for state-changing
// ops, and via estimateContractGas for the view verifier. We never assert on estimates where a
// receipt is available.

// --- Verifier ceilings (from the spike, recorded in the plan) ---
// ShuffleVerifier52.verify52: the spike's bench figure (1,569,952) was the inner verifyShuffle
// view. The production entrypoint verify52 wraps it in `try this.verifyShuffle(...)` — an extra
// CALL frame + selector-translation — so measured EXECUTION gas through verify52 is ~1,777,837
// (observed via the GasProbe gasleft() delta), ~208k above the inner-verify bench. The ceiling is
// set with margin over the real verify52 cost (the path disputes actually take), not the inner
// number. Spike inner-verify: 1,569,952; measured verify52: ~1,777,837.
const VERIFY52_CEILING = 1_850_000n
// RevealVerifier.verifyRevealWithSnark: spike 225,157; measured here ~226,919 (execution gas).
const VERIFY_REVEAL_CEILING = 260_000n

// --- ZkTable lifecycle ceilings (hardhat gas reporter, current) ---
// create ~205k measured → ceiling with ~27% margin.
const CREATE_CEILING = 260_000n
// join ~146k measured → ceiling with ~37% margin.
const JOIN_CEILING = 200_000n
// settle ~75k measured → ceiling with ~60% margin (settle is small; keep absolute headroom).
const SETTLE_CEILING = 120_000n
// resolveTimeout (setup-dispute forfeit/refund path) — measured below; ceiling set with margin.
const RESOLVE_TIMEOUT_CEILING = 130_000n

// Flatten a 52-card deck (each card is 4 field elements) into a flat uint256[] array.
const flatDeck = (deck: string[][]): bigint[] => deck.flat().map((v) => BigInt(v))

const STAKE = viem.parseEther('1')
const CLOCK = 60n
const DECK_KEY_A = [1n, 2n] as const
const DECK_KEY_B = [3n, 4n] as const

const deployZk = async () => {
  const zk = await hre.viem.deployContract('ZkTable')
  const rules = await hre.viem.deployContract('MockGameRules')
  const signers = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()
  const domain = makeDomain(await publicClient.getChainId(), zk.address)
  return { zk, rules, signers, publicClient, domain }
}

type ZkContext = Awaited<ReturnType<typeof deployZk>>

const createTable = async (ctx: ZkContext) => {
  const [a] = ctx.signers
  const hash = await ctx.zk.write.create(
    [ctx.rules.address, STAKE, CLOCK, viem.zeroAddress, DECK_KEY_A as unknown as [bigint, bigint]],
    { value: STAKE, account: a!.account },
  )
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.zk.abi, eventName: 'TableCreated' })
  return { tableId: created!.args.tableId as viem.Hex, receipt }
}

const joinTable = async (ctx: ZkContext, tableId: viem.Hex) => {
  const [, b] = ctx.signers
  const hash = await ctx.zk.write.join(
    [tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint]],
    { value: STAKE, account: b!.account },
  )
  return await ctx.publicClient.waitForTransactionReceipt({ hash })
}

const mkState = (tableId: viem.Hex, over: Partial<ChannelState> = {}): ChannelState => ({
  tableId,
  nonce: 1n,
  balanceA: viem.parseEther('1.5'),
  balanceB: viem.parseEther('0.5'),
  pot: 0n,
  deckCommitment: viem.keccak256(viem.toHex('deck')),
  phase: 1,
  gameStateHash: viem.keccak256(viem.toHex('game-state')),
  ...over,
})

// Place a contract's compiled runtime bytecode directly at `address` via hardhat_setCode.
// The vendored verifier-key contracts (~85KB) and RevealVerifier (~30KB) exceed EIP-170's
// 24576-byte deployed-code limit (and EIP-3860's init-code limit), so they cannot be deployed
// by a normal tx under the default network (allowUnlimitedContractSize:false). setCode writes
// runtime code directly, bypassing both checks, so these gas its run under plain `hardhat test`
// without relaxing the global size limit (which the Random suite depends on staying enforced).
const etch = async (artifactName: string, address: viem.Hex) => {
  const artifact = await hre.artifacts.readArtifact(artifactName)
  const testClient = await hre.viem.getTestClient()
  await testClient.setCode({ address, bytecode: artifact.deployedBytecode as viem.Hex })
}

type TypedDataSigner = {
  signTypedData(args: any): Promise<viem.Hex>
  address?: viem.Hex
  account?: { address: viem.Hex }
}
const signState = (signer: TypedDataSigner, domain: ChannelDomain, state: ChannelState) =>
  coreSignState(
    {
      address: (signer.address ?? signer.account!.address) as viem.Hex,
      signTypedData: (args) => signer.signTypedData(args),
    },
    domain,
    state,
  )

// Logs the measured gas alongside the ceiling so the observed value shows up in `npm run test`
// output (and any failure message carries the number that blew the budget).
const reportGas = (label: string, gasUsed: bigint, ceiling: bigint) => {
  // eslint-disable-next-line no-console
  console.log(`      gas[${label}] = ${gasUsed.toString()} (ceiling ${ceiling.toString()})`)
}

describe('ZkGas (gas-ceiling regression)', () => {
  describe('verifiers', () => {
    // Fixed addresses for the etched verifier-key runtime code. Arbitrary but deterministic;
    // ShuffleVerifier52 is constructed pointing at them.
    const VK1_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce521')
    const VK2_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce522')

    it(`verify52: valid proof < ${VERIFY52_CEILING}`, async () => {
      // The VerifierKeyExtra*_52 runtime code is ~85KB (over EIP-170), so etch it via setCode
      // rather than deploy it, then point a normally-deployed ShuffleVerifier52 at the keys.
      await etch('VerifierKeyExtra1_52', VK1_ADDR)
      await etch('VerifierKeyExtra2_52', VK2_ADDR)
      const shuffler = await hre.viem.deployContract('ShuffleVerifier52', [VK1_ADDR, VK2_ADDR])
      const probe = await hre.viem.deployContract('GasProbe')

      const pi: bigint[] = [...flatDeck(shuffleFixture.before), ...flatDeck(shuffleFixture.after)]
      const pkc: bigint[] = shuffleFixture.pkc.map((v) => BigInt(v))
      const proof = shuffleFixture.proof as `0x${string}`

      const publicClient = await hre.viem.getPublicClient()
      // Measure EXECUTION gas (gasleft() delta around the call inside GasProbe), not the full tx
      // gasUsed — the latter adds ~470k of tx intrinsic + multi-KB calldata cost that the spike's
      // bench figure excludes. The probe reverts if the proof is rejected, so a "cheap" pass can
      // only mean a genuinely accepted proof.
      const { result } = await publicClient.simulateContract({
        address: probe.address,
        abi: probe.abi,
        functionName: 'probeVerify52',
        args: [shuffler.address, proof, pi, pkc],
        gas: 29_000_000n,
      })
      const [gasUsed, ok] = result as readonly [bigint, boolean]
      reportGas('verify52', gasUsed, VERIFY52_CEILING)
      expect(ok).to.equal(true)
      expect(gasUsed).to.be.lessThan(VERIFY52_CEILING)
    })

    const REVEAL_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce523')

    it(`verifyRevealWithSnark: valid proof < ${VERIFY_REVEAL_CEILING}`, async () => {
      // RevealVerifier runtime code is ~30KB (over EIP-170), so etch it via setCode.
      await etch('RevealVerifier', REVEAL_ADDR)
      const reveal = await hre.viem.getContractAt('RevealVerifier', REVEAL_ADDR)
      const probe = await hre.viem.deployContract('GasProbe')

      const pi = revealFixture.pi.map((v) => BigInt(v)) as unknown as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint,
      ]
      const zkproof = revealFixture.zkproof.map((v) => BigInt(v)) as unknown as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
      ]

      const publicClient = await hre.viem.getPublicClient()
      // Execution gas of the verify call (gasleft() delta inside GasProbe), matching the spike
      // bench. Excludes tx intrinsic/calldata that estimateContractGas would fold in.
      const { result } = await publicClient.simulateContract({
        address: probe.address,
        abi: probe.abi,
        functionName: 'probeVerifyReveal',
        args: [reveal.address, pi, zkproof],
      })
      const [gasUsed, ok] = result as readonly [bigint, boolean]
      reportGas('verifyRevealWithSnark', gasUsed, VERIFY_REVEAL_CEILING)
      expect(ok).to.equal(true)
      expect(gasUsed).to.be.lessThan(VERIFY_REVEAL_CEILING)
    })
  })

  describe('ZkTable lifecycle', () => {
    it(`create < ${CREATE_CEILING}`, async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { receipt } = await createTable(ctx)
      reportGas('create', receipt.gasUsed, CREATE_CEILING)
      expect(receipt.gasUsed).to.be.lessThan(CREATE_CEILING)
    })

    it(`join < ${JOIN_CEILING}`, async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId } = await createTable(ctx)
      const receipt = await joinTable(ctx, tableId)
      reportGas('join', receipt.gasUsed, JOIN_CEILING)
      expect(receipt.gasUsed).to.be.lessThan(JOIN_CEILING)
    })

    it(`settle < ${SETTLE_CEILING}`, async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const [a, b] = ctx.signers
      const state = mkState(tableId)
      const sigA = await signState(a!, ctx.domain, state)
      const sigB = await signState(b!, ctx.domain, state)
      const hash = await ctx.zk.write.settle([tableId, state, sigA, sigB], { account: a!.account })
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash })
      reportGas('settle', receipt.gasUsed, SETTLE_CEILING)
      expect(receipt.gasUsed).to.be.lessThan(SETTLE_CEILING)
    })

    it(`resolveTimeout (forfeit path) < ${RESOLVE_TIMEOUT_CEILING}`, async () => {
      // Setup-dispute timeout: refunds both escrows in full. Measured below.
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const [a] = ctx.signers
      await ctx.zk.write.disputeSetup([tableId], { account: a!.account })
      await helpers.mine(Number(CLOCK) + 1)
      const hash = await ctx.zk.write.resolveTimeout([tableId], { account: a!.account })
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash })
      reportGas('resolveTimeout', receipt.gasUsed, RESOLVE_TIMEOUT_CEILING)
      expect(receipt.gasUsed).to.be.lessThan(RESOLVE_TIMEOUT_CEILING)
    })
  })
})
