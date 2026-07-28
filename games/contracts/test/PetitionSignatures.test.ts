import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { contractName } from '../lib/utils'
import { confirmTx } from './utils'

// ── EIP-712 domain/type — MUST byte-for-byte match packages/petition/src/digest.ts. This is the
// whole point of the cross-consistency test at the bottom of this file: the same signature has to
// validate both off-chain (the board, via petitionDigest) and on-chain (this contract), so one
// co-signature does double duty. Replicated inline here (rather than importing the built package,
// which has no `dist/` yet at this stage of the plan) so this suite has no build-order dependency.
const PETITION_TYPES = {
  Petition: [
    { name: 'petitionId', type: 'bytes32' },
    { name: 'statement', type: 'string' },
  ],
} as const

const petitionDomain = (chainId: number, verifyingContract: viem.Hex) => ({
  name: 'MsgBoard Petition',
  version: '1',
  chainId,
  verifyingContract,
}) as const

type TypedDataSigner = {
  signTypedData(args: {
    domain: ReturnType<typeof petitionDomain>
    types: typeof PETITION_TYPES
    primaryType: 'Petition'
    message: { petitionId: viem.Hex; statement: string }
  }): Promise<viem.Hex>
}

const signPetition = (
  signer: TypedDataSigner,
  chainId: number,
  verifyingContract: viem.Hex,
  petitionId: viem.Hex,
  statement: string,
) =>
  signer.signTypedData({
    domain: petitionDomain(chainId, verifyingContract),
    types: PETITION_TYPES,
    primaryType: 'Petition',
    message: { petitionId, statement },
  })

const deploy = async () => {
  const petition = await hre.viem.deployContract(contractName.PetitionSignatures)
  const publicClient = await hre.viem.getPublicClient()
  const signers = await hre.viem.getWalletClients()
  const chainId = await publicClient.getChainId()
  return { petition, publicClient, signers, chainId, hre }
}

type Ctx = Awaited<ReturnType<typeof deploy>>

// This contract reverts with plain require() reason strings ("bad sig", "length mismatch"), not
// custom errors — so, unlike expectations.revertedWithCustomError (built for ABI-decoded custom
// errors), this asserts the reason string shows up somewhere in the RPC error's message chain.
const expectRevertReason = async (p: Promise<unknown>, reason: string) => {
  let threw = false
  let text = ''
  try {
    await p
  } catch (e: any) {
    threw = true
    for (let cur = e; cur; cur = cur.cause) {
      text += ` ${cur.shortMessage ?? ''} ${cur.details ?? ''} ${cur.message ?? ''}`
    }
  }
  expect(threw, 'expected a revert, got success').to.equal(true)
  expect(text, `revert did not mention "${reason}": ${text}`).to.include(reason)
}

describe('PetitionSignatures', () => {
  describe('submit', () => {
    it('records a valid signature: signed==true, count==1, Signed emitted', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [relayer, signerWallet] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'We petition the board for X.'
      const signature = await signPetition(signerWallet, ctx.chainId, ctx.petition.address, petitionId, statement)

      const receipt = await confirmTx(
        ctx as any,
        ctx.petition.write.submit([petitionId, statement, signerWallet.account!.address, signature], {
          account: relayer.account,
        }),
      )
      const events = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.petition.abi })
      const signedEvents = events.filter((e) => e.eventName === 'Signed')
      expect(signedEvents.length).to.equal(1)
      expect((signedEvents[0] as any).args.petitionId).to.equal(petitionId)
      expect(viem.getAddress((signedEvents[0] as any).args.signer)).to.equal(
        viem.getAddress(signerWallet.account!.address),
      )

      expect(await ctx.petition.read.signed([petitionId, signerWallet.account!.address])).to.equal(true)
      expect(await ctx.petition.read.count([petitionId])).to.equal(1n)
    })

    it('rejects a signature over a different statement', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, signerWallet] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const signedStatement = 'statement X'
      const submittedStatement = 'statement Y'
      const signature = await signPetition(
        signerWallet,
        ctx.chainId,
        ctx.petition.address,
        petitionId,
        signedStatement,
      )
      await expectRevertReason(
        ctx.petition.write.submit([petitionId, submittedStatement, signerWallet.account!.address, signature]),
        'bad sig',
      )
    })

    it('rejects a signature attributed to the wrong signer', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, actualSigner, otherAccount] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'statement X'
      const signature = await signPetition(actualSigner, ctx.chainId, ctx.petition.address, petitionId, statement)
      await expectRevertReason(
        ctx.petition.write.submit([petitionId, statement, otherAccount.account!.address, signature]),
        'bad sig',
      )
    })

    it('is idempotent: a duplicate submit does not revert and count stays 1', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, signerWallet] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'statement X'
      const signature = await signPetition(signerWallet, ctx.chainId, ctx.petition.address, petitionId, statement)
      await confirmTx(
        ctx as any,
        ctx.petition.write.submit([petitionId, statement, signerWallet.account!.address, signature]),
      )
      // second submission of the exact same (petitionId, signer): must not revert.
      await confirmTx(
        ctx as any,
        ctx.petition.write.submit([petitionId, statement, signerWallet.account!.address, signature]),
      )
      expect(await ctx.petition.read.count([petitionId])).to.equal(1n)
    })

    it('is permissionless: an arbitrary msg.sender may relay a signature that is not theirs', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [relayer, signerWallet] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'statement X'
      const signature = await signPetition(signerWallet, ctx.chainId, ctx.petition.address, petitionId, statement)
      // relayer != signerWallet, and relayer is msg.sender for this tx.
      expect(viem.getAddress(relayer.account!.address)).to.not.equal(viem.getAddress(signerWallet.account!.address))
      await confirmTx(
        ctx as any,
        ctx.petition.write.submit([petitionId, statement, signerWallet.account!.address, signature], {
          account: relayer.account,
        }),
      )
      expect(await ctx.petition.read.signed([petitionId, signerWallet.account!.address])).to.equal(true)
    })
  })

  describe('submitBatch', () => {
    it('records each new signer once, skips a duplicate in the same batch, count==2', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, a, b] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'statement X'
      const sigA = await signPetition(a, ctx.chainId, ctx.petition.address, petitionId, statement)
      const sigB = await signPetition(b, ctx.chainId, ctx.petition.address, petitionId, statement)

      const receipt = await confirmTx(
        ctx as any,
        ctx.petition.write.submitBatch([
          petitionId,
          statement,
          [a.account!.address, a.account!.address, b.account!.address],
          [sigA, sigA, sigB],
        ]),
      )
      const events = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.petition.abi })
      const signedEvents = events.filter((e) => e.eventName === 'Signed')
      // only two new (signer) recordings -> two Signed events, not three.
      expect(signedEvents.length).to.equal(2)
      expect(await ctx.petition.read.count([petitionId])).to.equal(2n)
      expect(await ctx.petition.read.signed([petitionId, a.account!.address])).to.equal(true)
      expect(await ctx.petition.read.signed([petitionId, b.account!.address])).to.equal(true)
    })

    it('reverts the whole batch if any signature is bad', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, a, b] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-1'))
      const statement = 'statement X'
      const sigA = await signPetition(a, ctx.chainId, ctx.petition.address, petitionId, statement)
      // sign a DIFFERENT statement for b, then submit it against `statement` -> bad sig.
      const badSigB = await signPetition(b, ctx.chainId, ctx.petition.address, petitionId, 'a different statement')

      await expectRevertReason(
        ctx.petition.write.submitBatch([
          petitionId,
          statement,
          [a.account!.address, b.account!.address],
          [sigA, badSigB],
        ]),
        'bad sig',
      )
      // the whole tx reverted -> even the good signature (a) was not recorded.
      expect(await ctx.petition.read.count([petitionId])).to.equal(0n)
    })
  })

  // The key test: the SAME digest construction as packages/petition/src/digest.ts (domain name
  // "MsgBoard Petition" / version "1" / chainId / verifyingContract, type
  // `Petition(bytes32 petitionId,string statement)`, message {petitionId, statement}) must be
  // accepted by the deployed contract. If this test fails, a signature collected by the board
  // would NOT validate on-chain (or vice versa) — the two halves of the system would have silently
  // diverged.
  describe('cross-consistency with @msgboard/petition\'s digest', () => {
    it('accepts a signature built with the exact off-chain domain/type/message shape', async () => {
      const ctx: Ctx = await helpers.loadFixture(deploy)
      const [, signerWallet] = ctx.signers
      const petitionId = viem.keccak256(viem.toHex('petition-cross-consistency'))
      const statement = 'Cross-consistency: one signature, two validators.'

      // This IS petitionDigest() from packages/petition/src/digest.ts, inlined so this test has no
      // build-order dependency on that package's dist/ output. Domain/types/message are identical.
      const offChainDigest = viem.hashTypedData({
        domain: petitionDomain(ctx.chainId, ctx.petition.address),
        types: PETITION_TYPES,
        primaryType: 'Petition',
        message: { petitionId, statement },
      })

      const signature = await signPetition(signerWallet, ctx.chainId, ctx.petition.address, petitionId, statement)

      // sanity: the signature recovers to the signer against the same digest independently
      // computed via viem.hashTypedData (i.e. not just "whatever the contract happens to accept").
      const recovered = await viem.recoverTypedDataAddress({
        domain: petitionDomain(ctx.chainId, ctx.petition.address),
        types: PETITION_TYPES,
        primaryType: 'Petition',
        message: { petitionId, statement },
        signature,
      })
      expect(viem.getAddress(recovered)).to.equal(viem.getAddress(signerWallet.account!.address))
      void offChainDigest // computed for documentation/clarity; the real proof is the on-chain accept below.

      await confirmTx(
        ctx as any,
        ctx.petition.write.submit([petitionId, statement, signerWallet.account!.address, signature]),
      )
      expect(await ctx.petition.read.signed([petitionId, signerWallet.account!.address])).to.equal(true)
      expect(await ctx.petition.read.count([petitionId])).to.equal(1n)
    })
  })
})
