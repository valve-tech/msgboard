import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { makeDomain, hashSessionState, type SessionState } from '@msgboard/games'

describe('SessionStateSig', () => {
  it('TS hashSessionState matches the on-chain EIP-712 digest for a fully populated state', async () => {
    const harness = await hre.viem.deployContract('SessionStateHarness')
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const domain = makeDomain(chainId, harness.address)
    const state: SessionState = {
      tableId: viem.keccak256(viem.toHex('table-1')),
      nonce: 7n,
      balancePlayer: 1500n,
      balanceHouse: 500n,
      settlementMode: 1,
      gameId: 2,
      gameStateHash: viem.keccak256(viem.toHex('game-state')),
      rngCommit: viem.keccak256(viem.toHex('commit')),
    }
    const offChain = hashSessionState(domain, state)
    const onChain = await harness.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })
})
