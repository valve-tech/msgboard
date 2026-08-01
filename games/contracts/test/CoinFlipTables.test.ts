import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

const mkTable = async (ctx: testUtils.Context, opts?: { mult?: number; maxStake?: bigint; hotTarget?: bigint; account?: any }) => {
  const account = opts?.account ?? ctx.signers[0]!.account
  await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.createTable(
    [opts?.mult ?? 196, opts?.maxStake ?? viem.parseEther('10'), opts?.hotTarget ?? viem.parseEther('100')],
    { account },
  ))
  const evs = await ctx.coinFlipTables.getEvents.TableCreated()
  return evs[evs.length - 1]!.args.tableId as viem.Hex
}

const approveChips = async (ctx: testUtils.Context, account: any, amount: bigint) => {
  await testUtils.confirmTx(ctx, ctx.ERC20.write.approve([ctx.coinFlipTables.address, amount], { account }))
}

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

  describe('bankroll', () => {
    it('funds hot and cold, and withdraws from each', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx)
      await approveChips(ctx, op, viem.parseEther('30'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('10')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
      let t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('10')) // hot
      expect(t[2]).to.equal(viem.parseEther('20')) // cold
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.withdrawCold([tableId, viem.parseEther('20')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.withdrawHot([tableId, viem.parseEther('4')], { account: op }))
      t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('6'))
      expect(t[2]).to.equal(0n)
    })

    it('promotes cold to hot and demotes hot to cold', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx)
      await approveChips(ctx, op, viem.parseEther('20'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.promote([tableId, viem.parseEther('12')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.demote([tableId, viem.parseEther('2')], { account: op }))
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('10')) // hot
      expect(t[2]).to.equal(viem.parseEther('10')) // cold
    })

    it('reverts withdrawing more hot than available', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx)
      await approveChips(ctx, op, viem.parseEther('5'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('5')], { account: op }))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.withdrawHot([tableId, viem.parseEther('6')], { account: op }),
        'InsufficientHot',
      )
    })
  })

  describe('stake', () => {
    it('stakes and unstakes, kept separate from bankroll', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx)
      await approveChips(ctx, op, viem.parseEther('10'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.stakeForRank([tableId, viem.parseEther('10')], { account: op }))
      let t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[4]).to.equal(viem.parseEther('10')) // stake
      expect(t[1]).to.equal(0n) // hot untouched
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.unstake([tableId, viem.parseEther('4')], { account: op }))
      t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[4]).to.equal(viem.parseEther('6'))
    })

    it('reverts unstaking more than staked', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx)
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.unstake([tableId, 1n], { account: op }),
        'InsufficientStake',
      )
    })
  })

  describe('refillHot', () => {
    it('tops hot up to hotTarget from cold, callable by anyone', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const stranger = ctx.signers[3]!.account
      const tableId = await mkTable(ctx, { hotTarget: viem.parseEther('10') })
      await approveChips(ctx, op, viem.parseEther('30'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('3')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
      // stranger triggers refill; hot goes 3 -> 10, cold 20 -> 13
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.refillHot([tableId], { account: stranger }))
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('10'))
      expect(t[2]).to.equal(viem.parseEther('13'))
    })

    it('caps at cold when cold < needed, and reverts when hot already at target', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const op = ctx.signers[0]!.account
      const tableId = await mkTable(ctx, { hotTarget: viem.parseEther('10') })
      await approveChips(ctx, op, viem.parseEther('12'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('10')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('2')], { account: op }))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.refillHot([tableId], { account: op }),
        'NothingToRefill',
      )
    })
  })
})
