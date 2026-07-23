import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'
import { contractName } from '../lib/utils'

describe('CoinFlip', () => {
  describe('enter', () => {
    it('escrows the stake and records an active entry', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [player] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: player.account }))
      const publicClient = await ctx.hre.viem.getPublicClient()
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(stake)
      const entry = await ctx.coinFlip.read.entries([1n])
      // tuple order: [player, side, stake, subsetHash, enteredAtBlock, active]
      expect(entry[2]).to.equal(stake)
      expect(entry[5]).to.equal(true)
    })

    it('rejects a zero stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: 0n }),
        'ZeroStake',
      )
    })

    it('rejects an invalid side', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([2, subset, []], { value: viem.parseEther('1') }),
        'WrongSide',
      )
    })

    it('rejects an unvalidatable subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([0, [ctx.signers[9]!.account.address], []], { value: viem.parseEther('1') }),
        'BadSubset',
      )
    })
  })

  describe('matching', () => {
    it('queues same-side entrants and pairs the first opposite-side entrant on the same subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b, c] = ctx.signers
      const stake = viem.parseEther('1')
      // two heads, no tails -> both queue, none paired
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: b.account }))
      expect((await ctx.coinFlip.getEvents.Paired()).length).to.equal(0)
      // first tails pairs with the oldest heads (entry 1 = a)
      await expectations.emit(ctx,
        ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: c!.account }),
        ctx.coinFlip, 'Paired', { heads: viem.getAddress(a!.account!.address) })
    })

    it('does not match across different stakes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: viem.parseEther('1'), account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, []], { value: viem.parseEther('2'), account: b.account }))
      expect((await ctx.coinFlip.getEvents.Paired()).length).to.equal(0)
    })

    it('does not match across different validator subsets', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      // setUpValidators allowlists validators on coinFlip and inks their preimages
      const { subset: subsetA } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const { subset: subsetB } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 4)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subsetA, []], { value: stake, account: a.account }))
      // subsetB differs from subsetA -> different subsetHash -> no match
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subsetB, []], { value: stake, account: b.account }))
      expect((await ctx.coinFlip.getEvents.Paired()).length).to.equal(0)
    })

    it('heats validators and records a key on pairing', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      // first entrant has no opposite-side match yet -> queues, no heat
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      // second entrant completes the pair -> heats with the validator subset
      await expectations.emit(ctx,
        ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }),
        ctx.random, 'Start')
    })
  })

  describe('queue tombstone scan cap', () => {
    it('skips up to MAX_QUEUE_SCAN cancelled entries and still matches an active one', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const stake = viem.parseEther('1')
      // fill the queue with cancelled heads entries (tombstones)
      for (let i = 0; i < 5; i++) {
        const signer = ctx.signers[i]!
        await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: signer.account }))
        await testUtils.confirmTx(ctx, ctx.coinFlip.write.cancel([BigInt(i + 1)], { account: signer.account }))
      }
      // add one live heads entry at the end of the queue
      const live = ctx.signers[5]!
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: live.account }))
      // a tails entrant should scan past tombstones and pair with the live one
      const matcher = ctx.signers[6]!
      await expectations.emit(ctx,
        ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: matcher.account }),
        ctx.coinFlip, 'Paired')
    })
  })

  describe('recovery', () => {
    it('lets an unmatched entrant cancel for a refund', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      const publicClient = await ctx.hre.viem.getPublicClient()
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(stake)
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.cancel([1n], { account: a.account }))
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })

    it('rejects cancel from a non-owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.cancel([1n], { account: b.account }),
        'NotEntrant',
      )
    })

    it('refunds both players when a paired flip goes stale', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const flipId = (await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash }))[0]!.args.flipId as viem.Hex
      await helpers.mine(201)
      await expectations.changeEtherBalances(ctx, ctx.coinFlip.write.refundStale([flipId]), [heads!.account.address, tails!.account.address], [stake, stake])
    })

    it('rejects refundStale before the timeout window', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      const [paired] = await ctx.coinFlip.getEvents.Paired()
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.refundStale([paired!.args.flipId!]),
        'TooEarly',
      )
    })
  })

  describe('settlement', () => {
    it('pays the parity-selected winner via onCast after a real cast', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const heated = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!
      const key = heated.args.key as viem.Hex
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const settled = await ctx.coinFlip.getEvents.Settled()
      expect(settled.length).to.equal(1)
      const seed = (await ctx.random.read.randomness([key])).seed as viem.Hex
      const expectedWinner = (BigInt(seed) & 1n) === 0n ? heads!.account.address : tails!.account.address
      expect(viem.getAddress(settled[0]!.args.winner as viem.Hex)).to.equal(viem.getAddress(expectedWinner))
    })

    it('pays the whole pot to the winner and leaves no dust', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const caster = ctx.signers[5]!
      const stake = viem.parseEther('1')
      const publicClient = await ctx.hre.viem.getPublicClient()
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(stake * 2n)
      const heated = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!
      const key = heated.args.key as viem.Hex
      const before = {
        heads: await publicClient.getBalance({ address: heads!.account.address }),
        tails: await publicClient.getBalance({ address: tails!.account.address }),
      }
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets], { account: caster.account }))
      const seed = (await ctx.random.read.randomness([key])).seed as viem.Hex
      const winnerIsHeads = (BigInt(seed) & 1n) === 0n
      const winnerAddr = winnerIsHeads ? heads!.account.address : tails!.account.address
      const after = await publicClient.getBalance({ address: winnerAddr })
      expect(after - (winnerIsHeads ? before.heads : before.tails)).to.equal(stake * 2n)
      // whole pot left, no residue
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })

    it('refundStale returns both stakes when no cast happens before the timeout', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const flipId = (await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash }))[0]!.args.flipId as viem.Hex
      await helpers.mine(201)
      await expectations.changeEtherBalances(ctx, ctx.coinFlip.write.refundStale([flipId]), [heads!.account.address, tails!.account.address], [stake, stake])
    })
  })

  // A flip taken to a finalized seed (cast) and a flip taken to staleness (refundStale) must each
  // be terminal: no second settlement, no double pay. These exercise the shared _settle/claim guard.
  describe('double-resolution guards', () => {
    const settleFlip = async (ctx: testUtils.Context) => {
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const caster = ctx.signers[5]!
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      const heated = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!
      const key = heated.args.key as viem.Hex
      const [paired] = await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash })
      const flipId = paired!.args.flipId!
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets], { account: caster.account }))
      return { flipId, stake, key, locations, secrets }
    }

    it('rejects claim on a flip already settled via onCast', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { flipId } = await settleFlip(ctx)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.claim([flipId]),
        'AlreadyResolved',
      )
    })

    it('rejects cancel of an entry consumed by a pair', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      // entry 1 (heads) queues, entry 2 (tails) completes the pair -> entry 1 is consumed/inactive
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.cancel([1n], { account: a.account }),
        'AlreadyResolved',
      )
    })

    it('rejects refundStale on an already-settled flip', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { flipId } = await settleFlip(ctx)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.refundStale([flipId]),
        'AlreadyResolved',
      )
    })

    it('rejects claim on a flip already refunded as stale (no double pay)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      const [paired] = await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash })
      const flipId = paired!.args.flipId!
      await helpers.mine(201)
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.refundStale([flipId]))
      // status is Refunded (not Pending) -> claim must revert AlreadyResolved
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.claim([flipId]),
        'AlreadyResolved',
      )
    })
  })

  describe('claim fallback (onCast push failed)', () => {
    it('reverts TooEarly when the seed is not finalized', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      const [paired] = await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash })
      // paired but never cast -> seed is zero -> claim must revert TooEarly
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.claim([paired!.args.flipId!]),
        'TooEarly',
      )
    })

    it('pays the winner 2*stake after a failed onCast push, leaving no dust', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const caster = ctx.signers[5]!
      const funder = ctx.signers[6]!
      const stake = viem.parseEther('1')
      const publicClient = await ctx.hre.viem.getPublicClient()

      // A contract that rejects ETH while reject==true. It enters BOTH sides so it is the winner
      // regardless of seed parity; the onCast push to it then fails -> flip stays Pending with the
      // seed finalized -> after flipping reject off, claim pays it.
      const receiver = await ctx.hre.viem.deployContract(contractName.RejectableReceiver as any, [])
      await testUtils.confirmTx(ctx,
        receiver.write.enter([ctx.coinFlip.address, 0, subset, []], { value: stake, account: funder.account }))
      const matchReceipt = await testUtils.confirmTx(ctx,
        receiver.write.enter([ctx.coinFlip.address, 1, subset, locations], { value: stake, account: funder.account }))

      const heated = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!
      const key = heated.args.key as viem.Hex
      const [paired] = await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash })
      const flipId = paired!.args.flipId!

      // cast finalizes the seed; the onCast push to the receiver reverts and Random emits
      // FailedToCall, so the flip is NOT settled and the pot still sits in the contract.
      await expectations.emit(ctx,
        ctx.random.write.cast([key, locations, secrets], { account: caster.account }),
        ctx.random, 'FailedToCall')
      const seed = (await ctx.random.read.randomness([key])).seed
      expect(seed).to.not.equal(viem.zeroHash)
      // flip stayed Pending; the whole pot is still escrowed
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(stake * 2n)

      // now the receiver accepts ETH; claim pays it the full pot, contract balance returns to 0
      await testUtils.confirmTx(ctx, receiver.write.setReject([false], { account: funder.account }))
      const before = await publicClient.getBalance({ address: receiver.address })
      await expectations.emit(ctx, ctx.coinFlip.write.claim([flipId], { account: caster.account }), ctx.coinFlip, 'Settled')
      const after = await publicClient.getBalance({ address: receiver.address })
      expect(after - before).to.equal(stake * 2n)
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })

    it('refundStale cannot unwind a flip whose seed already finalized (claim is the only resolution)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const caster = ctx.signers[5]!
      const funder = ctx.signers[6]!
      const stake = viem.parseEther('1')
      const publicClient = await ctx.hre.viem.getPublicClient()

      // receiver enters both sides so it is the winner regardless of parity; the onCast push fails
      // and the flip stays Pending with the seed finalized.
      const receiver = await ctx.hre.viem.deployContract(contractName.RejectableReceiver as any, [])
      await testUtils.confirmTx(ctx, receiver.write.enter([ctx.coinFlip.address, 0, subset, []], { value: stake, account: funder.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, receiver.write.enter([ctx.coinFlip.address, 1, subset, locations], { value: stake, account: funder.account }))
      const key = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!.args.key as viem.Hex
      const flipId = (await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash }))[0]!.args.flipId!
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets], { account: caster.account }))
      expect((await ctx.random.read.randomness([key])).seed).to.not.equal(viem.zeroHash)

      // let the receiver accept ETH again, so a refund transfer itself would NOT fail — this
      // isolates the seed check as the reason refundStale is rejected (not the ETH transfer).
      await testUtils.confirmTx(ctx, receiver.write.setReject([false], { account: funder.account }))

      // pass the stale timeout. The seed IS finalized, so refundStale must refuse — a decided flip
      // can only be settled to the winner via claim, never unwound to a mutual refund. (Pre-fix,
      // refundStale ignored the seed and would have refunded both, escaping the decided outcome.)
      await helpers.mine(201)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.refundStale([flipId]),
        'TooEarly',
      )

      // the rightful resolution: claim pays the winner the full pot
      await expectations.emit(ctx, ctx.coinFlip.write.claim([flipId], { account: caster.account }), ctx.coinFlip, 'Settled')
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })

    it('refundStale opens immediately via the chop path, before the stale timeout', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: b.account }))
      const key = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!.args.key as viem.Hex
      const flipId = (await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash }))[0]!.args.flipId!
      // expire the heat window and chop -> onChop sets choppedInstance; the seed never formed
      await helpers.mine(12)
      await testUtils.confirmTx(ctx, ctx.random.write.chop([key, locations]))
      expect(await ctx.coinFlip.read.choppedInstance([flipId])).to.equal(true)
      // both players are refunded now (chopped + seed missing), without waiting for STALE_BLOCKS
      await expectations.changeEtherBalances(ctx,
        ctx.coinFlip.write.refundStale([flipId]),
        [a!.account.address, b!.account.address],
        [stake, stake],
      )
    })
  })

  describe('validator-only entropy', () => {
    it('emits no Ink event from the game during a full flip (the game inks nothing)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const inkEvents = await ctx.random.getEvents.Ink({}, { blockHash: matchReceipt.blockHash })
      const gameInks = inkEvents.filter((e) => viem.getAddress((e.args as any).provider) === viem.getAddress(ctx.coinFlip.address))
      expect(gameInks.length).to.equal(0)
    })
  })

  // Property fuzzing (Hardhat). Fuzzes seed parity and stake; the validator-only seed decides the
  // winner, so we push a fuzzed seed through the real onCast as Random. Asserts the parity winner
  // takes exactly 2*stake and the contract is left with no dust. Seeded LCG -> reproducible.
  describe('property fuzzing', () => {
    const ITERATIONS = 40
    const makeRng = (seed: number) => {
      let s = seed >>> 0
      return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 0x100000000 }
    }
    const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))

    it(`pays the parity winner exactly 2*stake with no dust across ${ITERATIONS} fuzzed flips`, async () => {
      const rng = makeRng(0xbeef)
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const ctx = await helpers.loadFixture(testUtils.deploy)
        const publicClient = await ctx.hre.viem.getPublicClient()
        const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
        const heads = ctx.signers[1]
        const tails = ctx.signers[2]
        const stake = viem.parseEther('1') * BigInt(randInt(rng, 1, 9))

        await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
        const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
        const key = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]!.args.key as viem.Hex

        const seedVal = BigInt(randInt(rng, 0, 0xffffff)) * 31337n + BigInt(iter)
        const parity = Number(seedVal & 1n) // 0 = heads, 1 = tails
        const expectedWinner = parity === 0 ? heads : tails
        const winnerBefore = await publicClient.getBalance({ address: expectedWinner.account.address })

        await ctx.hre.network.provider.send('hardhat_impersonateAccount', [ctx.random.address])
        await ctx.hre.network.provider.send('hardhat_setBalance', [ctx.random.address, viem.toHex(10n ** 18n)])
        await testUtils.confirmTx(ctx, ctx.coinFlip.write.onCast([key, viem.toHex(seedVal, { size: 32 })], { account: ctx.random.address }))
        await ctx.hre.network.provider.send('hardhat_stopImpersonatingAccount', [ctx.random.address])

        const winnerAfter = await publicClient.getBalance({ address: expectedWinner.account.address })
        expect(winnerAfter - winnerBefore, `iter ${iter}: parity winner gets 2*stake`).to.equal(stake * 2n)
        expect(await publicClient.getBalance({ address: ctx.coinFlip.address }), `iter ${iter}: no dust`).to.equal(0n)
      }
    })
  })
})
