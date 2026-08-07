import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { makeDomain, hashState, type ChannelState } from '@msgboard/zk-cards-core'
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
    }
    const offChain = hashState(domain, state)
    const onChain = await zk.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })
})
