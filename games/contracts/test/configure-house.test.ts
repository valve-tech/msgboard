/**
 * Integration test for configureHouse script using the Hardhat in-process chain.
 * Deploys fresh Chips + HouseChannel contracts, then exercises configureHouse and
 * asserts on-chain state (houseKey set, channel Chips balance increased by fund).
 *
 * Test approach: hardhat in-process chain (the fork harness already present in this
 * package via @nomicfoundation/hardhat-toolbox-viem).  No live RPC required.
 */
import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { privateKeyToAccount } from 'viem/accounts'
import { configureHouse } from '../scripts/configure-house'

const houseSigningKey = privateKeyToAccount(`0x${'ab'.repeat(32)}`)

describe('configureHouse script', () => {
  it('sets houseKey, mints treasury, and funds the house pool', async () => {
    // Use hardhat account[0] as the contract owner / operator
    const [owner] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    // Deploy fresh contracts
    const chips = await hre.viem.deployContract('Chips')
    const channel = await hre.viem.deployContract('HouseChannel', [chips.address])

    const treasury = 10_000n
    const fund = 5_000n

    // Capture channel's Chips balance before
    const balBefore = await chips.read.balanceOf([channel.address])

    const result = await configureHouse({
      walletClient: owner,
      chips: chips.address,
      channel: channel.address,
      houseKey: houseSigningKey.address,
      treasury,
      fund,
    })

    // Assert return shape: three tx hashes
    expect(result.setHouseKey).to.match(/^0x[0-9a-f]{64}$/i)
    expect(result.mint).to.match(/^0x[0-9a-f]{64}$/i)
    expect(result.fund).to.match(/^0x[0-9a-f]{64}$/i)

    // Assert houseKey was set on-chain
    const storedKey = await channel.read.houseKey()
    expect(viem.getAddress(storedKey as viem.Hex)).to.equal(viem.getAddress(houseSigningKey.address))

    // Assert channel's Chips balance increased by fund
    const balAfter = await chips.read.balanceOf([channel.address])
    expect(balAfter).to.equal(balBefore + fund)

    // All receipts should have been mined (waitForTransactionReceipt called in script)
    for (const hash of [result.setHouseKey, result.mint, result.fund]) {
      const receipt = await publicClient.getTransactionReceipt({ hash: hash as viem.Hex })
      expect(receipt.status).to.equal('success')
    }
  })
})
