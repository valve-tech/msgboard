import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

describe('CoinFlipTables', () => {
  describe('createTable', () => {
    it('records the operator, params, open=true, and zero balances', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [op] = ctx.signers
      const hash = await testUtils.confirmTx(
        ctx,
        ctx.coinFlipTables.write.createTable([196, viem.parseEther('10'), viem.parseEther('100')], { account: op.account }),
      )
      const created = await ctx.coinFlipTables.getEvents.TableCreated()
      expect(created.length).to.equal(1)
      const tableId = created[0]!.args.tableId as viem.Hex
      // tuple order: [operator, hot, cold, escrowed, stake, maxMultiplierX100, maxStake, hotTarget, open]
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(viem.getAddress(t[0] as viem.Hex)).to.equal(viem.getAddress(op.account.address))
      expect(t[1]).to.equal(0n) // hot
      expect(t[2]).to.equal(0n) // cold
      expect(t[5]).to.equal(196) // maxMultiplierX100
      expect(t[8]).to.equal(true) // open
    })

    it('rejects a multiplier outside [150,200]', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.createTable([149, viem.parseEther('10'), viem.parseEther('100')]),
        'BadMultiplier',
      )
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.createTable([201, viem.parseEther('10'), viem.parseEther('100')]),
        'BadMultiplier',
      )
    })
  })

  describe('setParams / setOpen', () => {
    it('lets the operator change any param and rejects non-operators', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [op, other] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.createTable([196, viem.parseEther('10'), viem.parseEther('100')], { account: op.account }))
      const tableId = (await ctx.coinFlipTables.getEvents.TableCreated())[0]!.args.tableId as viem.Hex
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.setParams([tableId, 150, viem.parseEther('5'), viem.parseEther('50')], { account: op.account }))
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[5]).to.equal(150)
      expect(t[6]).to.equal(viem.parseEther('5'))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.setParams([tableId, 160, 0n, 0n], { account: other!.account }),
        'NotOperator',
      )
    })
  })
})
