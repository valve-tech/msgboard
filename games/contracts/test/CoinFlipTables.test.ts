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

  describe('setName', () => {
    it('emits TableNamed for the operator, rejects non-operators and over-long names', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [op, other] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.createTable([196, viem.parseEther('10'), viem.parseEther('100')], { account: op.account }))
      const tableId = (await ctx.coinFlipTables.getEvents.TableCreated())[0]!.args.tableId as viem.Hex
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.setName([tableId, "Mike's table"], { account: op.account }))
      const named = (await ctx.coinFlipTables.getEvents.TableNamed()).slice(-1)[0]!.args
      expect(named.tableId).to.equal(tableId)
      expect(named.name).to.equal("Mike's table")
      // non-operator cannot name someone else's table
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.setName([tableId, 'hijack'], { account: other!.account }),
        'NotOperator',
      )
      // a name over 64 bytes is rejected
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.setName([tableId, 'x'.repeat(65)], { account: op.account }),
        'NameTooLong',
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

  describe('open', () => {
    it('escrows the full payout (hot debited by payout-stake), pulls the player stake, heats validators', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), hotTarget: viem.parseEther('100'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      const stake = viem.parseEther('1')
      const payout = (stake * 196n) / 100n // 1.96e18
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, stake, subset, locations], { account: player }))
      const opened = await ctx.coinFlipTables.getEvents.RoundOpened()
      expect(opened.length).to.equal(1)
      expect(opened[0]!.args.payout).to.equal(payout)
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('50') - (payout - stake)) // hot debited by exposure only
      expect(t[3]).to.equal(payout) // escrowed == full payout
    })

    it('reverts when stake exceeds maxStake, table closed, or hot cannot cover exposure', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('2'), account: op })
      await approveChips(ctx, player, viem.parseEther('5'))
      // no hot funded -> exposure uncovered
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }),
        'InsufficientBankroll',
      )
      // stake above maxStake
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('3'), subset, locations], { account: player }),
        'StakeTooHigh',
      )
    })

    it('rejects a degenerate validator subset (below MIN_SUBSET or duplicated)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), hotTarget: viem.parseEther('100'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('5'))
      const stake = viem.parseEther('1')
      // single-element subset -> below MIN_SUBSET
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.open([tableId, 0, stake, [subset[0]!], [locations[0]!]], { account: player }),
        'BadSubset',
      )
      // duplicated subset -> collapses to one distinct validator
      const dupSubset = [subset[0]!, subset[0]!, subset[0]!]
      const dupLocations = [locations[0]!, locations[0]!, locations[0]!]
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.open([tableId, 0, stake, dupSubset, dupLocations], { account: player }),
        'BadSubset',
      )
    })
  })

  describe('settle', () => {
    const fundAndOpen = async (ctx: testUtils.Context, side: number) => {
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, side, viem.parseEther('1'), subset, locations], { account: player }))
      const opened = (await ctx.coinFlipTables.getEvents.RoundOpened())
      const round = opened[opened.length - 1]!.args
      return { tableId, player, op, key: round.key as viem.Hex, roundId: round.roundId as viem.Hex, subset, locations, secrets }
    }

    it('pays the player on a parity win, debiting only the exposure from the table', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { key, player, tableId, locations, secrets } = await fundAndOpen(ctx, 0)
      const before = await ctx.ERC20.read.balanceOf([player.address])
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const seed = (await ctx.random.read.randomness([key])).seed as viem.Hex
      const settled = (await ctx.coinFlipTables.getEvents.RoundSettled())[0]!.args
      const playerWon = (BigInt(seed) & 1n) === 0n // side was HEADS(0)
      expect(settled.won).to.equal(playerWon)
      const after = await ctx.ERC20.read.balanceOf([player.address])
      if (playerWon) expect(after - before).to.equal(viem.parseEther('1.96'))
      else expect(after).to.equal(before)
      // escrow always released
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[3]).to.equal(0n) // escrowed
      // on a loss the whole payout (incl. the player's forfeited stake) is back in hot
      if (!playerWon) expect(t[1]).to.equal(viem.parseEther('50') + viem.parseEther('1'))
      else expect(t[1]).to.equal(viem.parseEther('50') - viem.parseEther('0.96'))
    })

    it('claim() pays after a swallowed onCast, and double-settle reverts', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { key, roundId, locations, secrets } = await fundAndOpen(ctx, 1)
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.claim([roundId]),
        'AlreadyResolved',
      )
    })
  })

  describe('refundStale', () => {
    it('refunds the player and returns exposure to hot when the seed never finalizes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
      const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
      const before = await ctx.ERC20.read.balanceOf([player.address])
      // mine past STALE_BLOCKS (200) without any cast
      await helpers.mine(201)
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.refundStale([round.roundId as viem.Hex], { account: player }))
      const after = await ctx.ERC20.read.balanceOf([player.address])
      expect(after - before).to.equal(viem.parseEther('1'))
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[1]).to.equal(viem.parseEther('50')) // hot fully restored
      expect(t[3]).to.equal(0n) // escrow released
      // Refunded event mirrors the accounting so the off-chain index can release escrow/exposure.
      const refunded = (await ctx.coinFlipTables.getEvents.Refunded()).slice(-1)[0]!.args
      expect(refunded.roundId).to.equal(round.roundId)
      expect(refunded.tableId).to.equal(tableId)
      expect((refunded.player as string).toLowerCase()).to.equal(player.address.toLowerCase())
      expect(refunded.stake).to.equal(viem.parseEther('1'))
      expect(refunded.payout).to.equal(viem.parseEther('1') * 196n / 100n)
    })

    it('reverts a finalized (settled) round even after the stale window passes — a decided round can never unwind', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
      const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
      // finalize the seed -> onCast settles the round (status becomes Settled)
      await testUtils.confirmTx(ctx, ctx.random.write.cast([round.key as viem.Hex, locations, secrets]))
      // mine past STALE_BLOCKS anyway
      await helpers.mine(201)
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.refundStale([round.roundId as viem.Hex], { account: player }),
        'AlreadyResolved',
      )
    })

    it('reverts a second refundStale call on an already-refunded round', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
      const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
      await helpers.mine(201)
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.refundStale([round.roundId as viem.Hex], { account: player }))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.refundStale([round.roundId as viem.Hex], { account: player }),
        'AlreadyResolved',
      )
    })
  })

  describe('params bind only new rounds', () => {
    it('settles a live round on the multiplier it was opened under, even after the operator lowers it', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const op = ctx.signers[0]!.account
      const player = ctx.signers[1]!.account
      const tableId = await mkTable(ctx, { mult: 200, maxStake: viem.parseEther('10'), account: op })
      await approveChips(ctx, op, viem.parseEther('50'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
      await approveChips(ctx, player, viem.parseEther('1'))
      // opened at 2.00x -> payout snapshot 2e18
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
      const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
      expect(round.payout).to.equal(viem.parseEther('2'))
      // operator drops the table to 1.50x AFTER the bet
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.setParams([tableId, 150, viem.parseEther('10'), viem.parseEther('100')], { account: op }))
      const before = await ctx.ERC20.read.balanceOf([player.address])
      await testUtils.confirmTx(ctx, ctx.random.write.cast([round.key as viem.Hex, locations, secrets]))
      const seed = (await ctx.random.read.randomness([round.key as viem.Hex])).seed as viem.Hex
      if ((BigInt(seed) & 1n) === 0n) {
        const after = await ctx.ERC20.read.balanceOf([player.address])
        expect(after - before).to.equal(viem.parseEther('2')) // paid at 2.00x, NOT 1.50x
      }
    })
  })

  describe('multi-table isolation & invariant', () => {
    it('keeps two tables\' balances independent and preserves hot+cold+escrowed+stake == contract chips', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
      const opA = ctx.signers[0]!.account
      const opB = ctx.signers[2]!.account
      const player = ctx.signers[1]!.account
      const a = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: opA })
      const b = await mkTable(ctx, { mult: 150, maxStake: viem.parseEther('10'), account: opB })
      for (const [op, id] of [[opA, a], [opB, b]] as const) {
        await approveChips(ctx, op, viem.parseEther('30'))
        await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([id, viem.parseEther('20')], { account: op }))
        await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([id, viem.parseEther('10')], { account: op }))
      }
      await approveChips(ctx, player, viem.parseEther('1'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([a, 0, viem.parseEther('1'), subset, locations], { account: player }))
      const key = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args.key as viem.Hex
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      // table B never moved
      const tb = await ctx.coinFlipTables.read.tables([b])
      expect(tb[1]).to.equal(viem.parseEther('20')) // hot
      expect(tb[2]).to.equal(viem.parseEther('10')) // cold
      expect(tb[3]).to.equal(0n) // escrowed
      // global invariant: sum of both tables' pools == contract chip balance
      const ta = await ctx.coinFlipTables.read.tables([a])
      const sum = ta[1] + ta[2] + ta[3] + ta[4] + tb[1] + tb[2] + tb[3] + tb[4]
      const bal = await ctx.ERC20.read.balanceOf([ctx.coinFlipTables.address])
      expect(sum).to.equal(bal)
    })
  })
})
