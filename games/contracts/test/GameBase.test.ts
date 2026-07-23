import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

describe('GameBase', () => {
  describe('ownership and allowlist', () => {
    it('sets the deployer as owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const owner = (await ctx.gameBaseHarness.read.owner()) as viem.Hex
      expect(viem.getAddress(owner)).to.equal(viem.getAddress(ctx.signers[0].account.address))
    })

    it('lets the owner add and remove validators and tracks the count', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const v = ctx.signers[5].account.address
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.addValidator([v]))
      expect(await ctx.gameBaseHarness.read.isValidator([v])).to.equal(true)
      expect(await ctx.gameBaseHarness.read.validatorCount()).to.equal(1n)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.removeValidator([v]))
      expect(await ctx.gameBaseHarness.read.isValidator([v])).to.equal(false)
      expect(await ctx.gameBaseHarness.read.validatorCount()).to.equal(0n)
    })

    it('rejects allowlist changes from a non-owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.addValidator([ctx.signers[5].account.address], { account: ctx.signers[1].account }),
        'OnlyOwner',
      )
    })

    it('transfers ownership and moves owner-only authority to the new owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const next = ctx.signers[1]
      await expectations.emit(ctx,
        ctx.gameBaseHarness.write.transferOwnership([next.account.address]),
        ctx.gameBaseHarness, 'OwnerTransferred',
      )
      expect(viem.getAddress((await ctx.gameBaseHarness.read.owner()) as viem.Hex)).to.equal(viem.getAddress(next.account.address))
      // the old owner has lost owner-only authority
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.addValidator([ctx.signers[5].account.address]),
        'OnlyOwner',
      )
      // the new owner now holds it
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.addValidator([ctx.signers[5].account.address], { account: next.account }))
      expect(await ctx.gameBaseHarness.read.isValidator([ctx.signers[5].account.address])).to.equal(true)
    })

    it('rejects transferOwnership from a non-owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.transferOwnership([ctx.signers[1].account.address], { account: ctx.signers[1].account }),
        'OnlyOwner',
      )
    })
  })

  describe('escrow', () => {
    it('accepts a matching stake and reverts a mismatch', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.takeStake([viem.parseEther('1')], { value: viem.parseEther('1') }))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.takeStake([viem.parseEther('1')], { value: viem.parseEther('2') }),
        'StakeMismatch',
      )
    })
  })

  describe('subset validation', () => {
    it('accepts a distinct allowlisted subset of at least MIN_SUBSET', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await ctx.gameBaseHarness.read.validateSubset([subset]) // view; no revert == pass
    })

    it('rejects a subset smaller than MIN_SUBSET', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.read.validateSubset([subset.slice(0, 2)]),
        'BadSubset',
      )
    })

    it('rejects a subset with a duplicate', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.read.validateSubset([[subset[0]!, subset[1]!, subset[0]!]]),
        'BadSubset',
      )
    })

    it('rejects a non-allowlisted member', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const outsider = ctx.signers[9]!.account.address
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.read.validateSubset([[subset[0]!, subset[1]!, outsider]]),
        'NotAllowlisted',
      )
    })
  })

  describe('_heatBound', () => {
    it('heats when locations equal the declared subset and returns a key', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const receipt = await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.heatBound([subset, locations]))
      const starts = await ctx.random.getEvents.Start({}, { blockHash: receipt.blockHash })
      expect(starts.length).to.equal(1)
    })

    it('reverts when a location provider does not match the declared subset (bait-and-switch)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const swapped = [locations[0]!, locations[1]!, { ...locations[2]!, provider: subset[0]! }]
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, swapped]),
        'SubsetMismatch',
      )
    })

    it('reverts when location count differs from the subset (no slack)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, locations.slice(0, 2)]),
        'SubsetMismatch',
      )
    })

    it('reverts when a subset member was de-allowlisted after creation', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.removeValidator([subset[2]!]))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, locations]),
        'NotAllowlisted',
      )
    })
  })

  describe('dispatch', () => {
    it('rejects a non-Random onCast caller', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const key = viem.keccak256(viem.toHex('key-1'))
      const instanceId = viem.keccak256(viem.toHex('instance-1'))
      const seed = viem.keccak256(viem.toHex('seed-1'))
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.bindInstance([key, instanceId]))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.onCast([key, seed]),
        'OnlyRandom',
      )
    })

    it('rejects a non-Random onChop caller', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const key = viem.keccak256(viem.toHex('key-2'))
      const instanceId = viem.keccak256(viem.toHex('instance-2'))
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.bindInstance([key, instanceId]))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.onChop([key]),
        'OnlyRandom',
      )
    })
  })
})
