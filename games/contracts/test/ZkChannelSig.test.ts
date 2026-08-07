import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  makeDomain, hashState, type ChannelState,
  hashDisputeSetupIntent, hashOpenDisputeIntent, hashRespondMoveIntent, hashReclaimTopUpIntent,
  hashCancelIntent, channelStateStructHash,
} from '@msgboard/zk-cards-core'
import { deployZkTable } from './x402'

describe('ZkChannelSig', () => {
  it('TS hashState matches the on-chain EIP-712 digest for a fully populated state', async () => {
    // ZkTable's constructor now takes the x402 wrapper-factory address (see ZkTable.sol's
    // IWrapperFactory); zeroAddress skips the create()-time clone-check entirely — moot here,
    // this test never calls create/join/topUp, only the pure stateDigest() view.
    const zk = await deployZkTable(viem.zeroAddress)
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const domain = makeDomain(chainId, zk.address)
    // nonzero values in EVERY field so a single transposed/missing field breaks parity
    const state: ChannelState = {
      tableId: viem.keccak256(viem.toHex('table-1')),
      nonce: 7n,
      balanceA: viem.parseEther('1.5'),
      balanceB: viem.parseEther('0.25'),
      pot: viem.parseEther('0.75'),
      deckCommitment: viem.keccak256(viem.toHex('deck')),
      phase: 3,
      gameStateHash: viem.keccak256(viem.toHex('game-state')),
      jointKeyCommit: viem.keccak256(viem.toHex('joint-key-commit')),
      shuffleRoot: viem.keccak256(viem.toHex('shuffle-root')),
    }
    const offChain = hashState(domain, state)
    const onChain = await zk.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })
})

// Solidity<->viem parity for the 2026-08 signed-intent relay's 5 typehashes (ZkTable.sol's
// "Signed-intent typehashes" section / SignedIntentBase.sol). Mirrors the ChannelState parity
// test above: nonzero/distinct values in every field so a transposed or missing field breaks
// parity, comparing the TS helper's digest against the matching on-chain `<name>IntentDigest`
// public view.
describe('ZkChannelSig — signed-intent relay typehashes', () => {
  const tableId = viem.keccak256(viem.toHex('table-relay-1'))
  const nonce = 42n
  const deadline = 1_999_999_999n

  it('DisputeSetupIntent digest parity', async () => {
    const zk = await deployZkTable(viem.zeroAddress)
    const domain = makeDomain(await (await hre.viem.getPublicClient()).getChainId(), zk.address)
    const offChain = hashDisputeSetupIntent(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.disputeSetupIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('OpenDisputeIntent digest parity (stateHash bound via channelStateStructHash)', async () => {
    const zk = await deployZkTable(viem.zeroAddress)
    const domain = makeDomain(await (await hre.viem.getPublicClient()).getChainId(), zk.address)
    const state: ChannelState = {
      tableId,
      nonce: 3n,
      balanceA: viem.parseEther('1'),
      balanceB: viem.parseEther('1'),
      pot: viem.parseEther('0.2'),
      deckCommitment: viem.keccak256(viem.toHex('deck')),
      phase: 2,
      gameStateHash: viem.keccak256(viem.toHex('gs')),
      jointKeyCommit: ('0x' + '00'.repeat(32)) as viem.Hex,
      shuffleRoot: ('0x' + '00'.repeat(32)) as viem.Hex,
    }
    const stateHash = channelStateStructHash(state)
    const demandKind = 2
    const demandSlot = 7
    const offChain = hashOpenDisputeIntent(domain, { tableId, stateHash, demandKind, demandSlot, nonce, deadline })
    const onChain = await zk.read.openDisputeIntentDigest([tableId, stateHash, demandKind, demandSlot, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('RespondMoveIntent digest parity', async () => {
    const zk = await deployZkTable(viem.zeroAddress)
    const domain = makeDomain(await (await hre.viem.getPublicClient()).getChainId(), zk.address)
    const gameStateHash = viem.keccak256(viem.toHex('gs'))
    const moveHash = viem.keccak256(viem.toHex('move'))
    const offChain = hashRespondMoveIntent(domain, { tableId, gameStateHash, moveHash, nonce, deadline })
    const onChain = await zk.read.respondWithMoveIntentDigest([tableId, gameStateHash, moveHash, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('ReclaimTopUpIntent digest parity', async () => {
    const zk = await deployZkTable(viem.zeroAddress)
    const domain = makeDomain(await (await hre.viem.getPublicClient()).getChainId(), zk.address)
    const offChain = hashReclaimTopUpIntent(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.reclaimTopUpIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })

  it('CancelIntent digest parity', async () => {
    const zk = await deployZkTable(viem.zeroAddress)
    const domain = makeDomain(await (await hre.viem.getPublicClient()).getChainId(), zk.address)
    const offChain = hashCancelIntent(domain, { tableId, nonce, deadline })
    const onChain = await zk.read.cancelIntentDigest([tableId, nonce, deadline])
    expect(onChain).to.equal(offChain)
  })
})

// End-to-end: sign each intent with viem's own signTypedData (via a local test account, not a
// hardhat network account) and relay it through the real `*For` entrypoint from an UNRELATED
// address — closing the loop from "TS helper produces the right digest" to "a real signature
// this library produces is actually accepted on-chain when relayed."
describe('ZkChannelSig — signed-intent relay end-to-end', () => {
  it('a viem-signed DisputeSetupIntent is accepted when relayed by an unrelated account', async () => {
    const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
    const zk = await deployZkTable(viem.zeroAddress)
    const rules = await hre.viem.deployContract('MockGameRules')
    const token = await hre.viem.deployContract('MockX402')
    const { buildCreateAuth, buildJoinAuth, makeX402Domain } = await import('./x402')
    const [, , relayer] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const domain = makeDomain(chainId, zk.address)
    const x402Domain = makeX402Domain(chainId, token.address)

    const aAccount = privateKeyToAccount(generatePrivateKey())
    const bAccount = privateKeyToAccount(generatePrivateKey())
    await token.write.mint([aAccount.address, viem.parseEther('10')])
    await token.write.mint([bAccount.address, viem.parseEther('10')])
    const aSigner = { address: aAccount.address, signTypedData: (args: any) => aAccount.signTypedData(args) }
    const bSigner = { address: bAccount.address, signTypedData: (args: any) => bAccount.signTypedData(args) }

    const createAuth = await buildCreateAuth(zk, token.address, x402Domain, aSigner as any, {
      rules: rules.address, buyIn: viem.parseEther('1'), joinStake: viem.parseEther('1'),
      clockBlocks: 60, channelKey: viem.zeroAddress, deckKey: [0n, 0n],
    })
    const createHash = await zk.write.create(
      [token.address, viem.parseEther('1'), rules.address, viem.parseEther('1'), 60, viem.zeroAddress, [0n, 0n], createAuth],
      { account: relayer!.account }, // relayer submits, never a or b
    )
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: zk.abi, eventName: 'TableCreated' })
    const tableId = created!.args.tableId!

    const joinAuth = await buildJoinAuth(zk, x402Domain, bSigner as any, {
      tableId, stake: viem.parseEther('1'), channelKey: viem.zeroAddress, deckKey: [0n, 0n],
    })
    await zk.write.join([tableId, viem.zeroAddress, [0n, 0n], joinAuth], { account: relayer!.account })

    const intentNonce = 0n
    const intentDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const sig = await hashDisputeSetupIntentAndSign(aSigner as any, domain, { tableId, nonce: intentNonce, deadline: intentDeadline })

    await zk.write.disputeSetupFor([tableId, intentNonce, intentDeadline, sig], { account: relayer!.account })
    const table = await zk.read.tables([tableId])
    expect(table[9]).to.equal(3) // Status.Disputed
    expect(table[13]).to.equal(1) // disputant == seat A (the signer), not the relayer
  })
})

async function hashDisputeSetupIntentAndSign(
  signer: { address: viem.Hex; signTypedData: (args: any) => Promise<viem.Hex> },
  domain: ReturnType<typeof makeDomain>,
  intent: { tableId: viem.Hex; nonce: bigint; deadline: bigint },
): Promise<viem.Hex> {
  const { signDisputeSetupIntent } = await import('@msgboard/zk-cards-core')
  return signDisputeSetupIntent(signer, domain, intent)
}
