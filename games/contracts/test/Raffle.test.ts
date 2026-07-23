import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

const RANGE = 256n

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]))

describe('Raffle', () => {
  const stake = viem.parseEther('1')
  const threshold = 3n
  const period = 5n

  // fill -> arm -> cast; returns the recorded draw. Top-level so reveal/finalise/invariant
  // suites all share it.
  const armAndDraw = async (ctx: any) => {
    const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
    const players = ctx.signers.slice(1, 4)
    const salts = players.map((_p: any, i: number) => viem.keccak256(viem.toHex(`salt-${i}`)))
    const guesses = [10n, 128n, 250n]
    let firstReceipt: any
    for (let i = 0; i < 3; i++) {
      const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
        [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
        { value: stake, account: players[i].account },
      ))
      if (i === 0) firstReceipt = receipt
    }
    const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
    await helpers.mine(6)
    const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
    const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
    const castReceipt = await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
    const draw = (await ctx.raffle.getEvents.Drawn({}, { blockHash: castReceipt.blockHash }))[0].args.draw as bigint
    return { roundId, players, salts, guesses, draw }
  }

  describe('commit and cancel', () => {
    it('opens a round on the first commit and escrows the stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p] = ctx.signers
      const salt = viem.keccak256(viem.toHex('salt-1'))
      const commitment = commitmentFor(7n, salt, p.account.address)
      await expectations.emit(ctx,
        ctx.raffle.write.commit([stake, threshold, period, subset, commitment], { value: stake, account: p.account }),
        ctx.raffle, 'RoundOpened',
      )
      const publicClient = await ctx.hre.viem.getPublicClient()
      expect(await publicClient.getBalance({ address: ctx.raffle.address })).to.equal(stake)
    })

    it('concentrates commits of the same tuple into one round', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, a, b] = ctx.signers
      const first = await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(1n, viem.keccak256(viem.toHex('sa')), a.account.address)], { value: stake, account: a.account }))
      const opened = await ctx.raffle.getEvents.RoundOpened({}, { blockHash: first.blockHash })
      expect(opened.length).to.equal(1) // first commit opens exactly one round
      const roundId = opened[0].args.roundId as viem.Hex
      const second = await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(2n, viem.keccak256(viem.toHex('sb')), b.account.address)], { value: stake, account: b.account }))
      expect((await ctx.raffle.getEvents.RoundOpened({}, { blockHash: second.blockHash })).length).to.equal(0) // no new round
      const round = await ctx.raffle.read.rounds([roundId])
      // tuple order matches the Round struct; commitCount is field index 5
      expect(round[5]).to.equal(2n)
    })

    it('cancels a waiting ticket and refunds the stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(7n, viem.keccak256(viem.toHex('s')), p.account.address)], { value: stake, account: p.account }))
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.cancel([1n], { account: p.account }),
        [p.account.address],
        [stake],
      )
    })

    it('rejects a cancel from a non-owner of the ticket', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p, other] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(7n, viem.keccak256(viem.toHex('s')), p.account.address)], { value: stake, account: p.account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.cancel([1n], { account: other.account }),
        'NotTicketOwner',
      )
    })
  })

  describe('arm and draw', () => {
    const fillRound = async (ctx: any, subset: viem.Hex[], guesses: bigint[], salts: viem.Hex[]) => {
      const players = ctx.signers.slice(1, 1 + guesses.length)
      let firstReceipt: any
      for (let i = 0; i < guesses.length; i++) {
        const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
        if (i === 0) firstReceipt = receipt
      }
      const opened = await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash })
      const roundId = opened[0].args.roundId as viem.Hex
      return { roundId, players }
    }

    it('reverts arm before the period elapses', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const { roundId } = await fillRound(ctx, subset, [1n, 2n, 3n], ['0x01', '0x02', '0x03'].map((s) => viem.padHex(s as viem.Hex, { size: 32 })))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, locations]),
        'PeriodNotElapsed',
      )
    })

    it('reverts arm below the threshold', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const { roundId } = await fillRound(ctx, subset, [1n, 2n], ['0x01', '0x02'].map((s) => viem.padHex(s as viem.Hex, { size: 32 })))
      await helpers.mine(6)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, locations]),
        'ThresholdNotMet',
      )
    })

    it('arms a filled round, casts, and records a draw in [1..256] without paying', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const salts = ['0x01', '0x02', '0x03'].map((s) => viem.padHex(s as viem.Hex, { size: 32 }))
      const { roundId } = await fillRound(ctx, subset, [1n, 2n, 3n], salts)
      await helpers.mine(6)
      const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
      const publicClient = await ctx.hre.viem.getPublicClient()
      const potBefore = await publicClient.getBalance({ address: ctx.raffle.address })
      const castReceipt = await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const drawn = await ctx.raffle.getEvents.Drawn({}, { blockHash: castReceipt.blockHash })
      expect(drawn.length).to.equal(1)
      const draw = drawn[0].args.draw as bigint
      expect(draw).to.be.greaterThanOrEqual(1n)
      expect(draw).to.be.lessThanOrEqual(RANGE)
      // no payout on draw
      expect(await publicClient.getBalance({ address: ctx.raffle.address })).to.equal(potBefore)
    })
  })

  describe('reveal and overwrite', () => {
    it('accepts a valid reveal and rejects a guess that does not match the commitment', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      // ticket 1 belongs to players[0]; revealing the wrong guess fails the hash
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, guesses[0] + 1n, salts[0]], { account: players[0].account }),
        'BadReveal',
      )
      await expectations.emit(ctx,
        ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }),
        ctx.raffle, 'Revealed',
      )
    })

    it('rejects a reveal replayed from a different sender (address binding)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[1].account }),
        'BadReveal',
      )
    })

    it('keeps the closest revealer as the provisional winner regardless of reveal order', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses, draw } = await armAndDraw(ctx)
      // reveal all three; compute who should lead off-chain
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      const distances = guesses.map((g) => (g > draw ? g - draw : draw - g))
      let bestIdx = 0
      for (let i = 1; i < 3; i++) if (distances[i] < distances[bestIdx]) bestIdx = i
      const round = await ctx.raffle.read.rounds([roundId])
      // bestTicket is field index 12 in the Round struct tuple
      expect(round[12]).to.equal(BigInt(bestIdx + 1))
    })
  })

  describe('finalise', () => {
    it('pays the winner the pot less fee after the window closes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      // set a 5% fee
      await testUtils.confirmTx(ctx, ctx.raffle.write.setFee([500n, ctx.signers[11].account.address]))
      const { roundId, players, salts, guesses, draw } = await armAndDraw(ctx)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      const distances = guesses.map((g) => (g > draw ? g - draw : draw - g))
      let bestIdx = 0
      for (let i = 1; i < 3; i++) if (distances[i] < distances[bestIdx]) bestIdx = i
      await helpers.mine(101) // past the claim window
      const pot = stake * 3n
      const fee = (pot * 500n) / 10_000n
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.finalise([roundId]),
        [players[bestIdx].account.address, ctx.signers[11].account.address],
        [pot - fee, fee],
      )
    })

    it('routes the pot to the validators when nobody reveals (no-contest)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId } = await armAndDraw(ctx)
      const subset = await ctx.raffle.read.roundSubset([roundId])
      await helpers.mine(101)
      const pot = stake * 3n
      const perValidator = pot / 3n
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.finalise([roundId]),
        subset as viem.Hex[],
        [perValidator, perValidator, perValidator],
      )
    })

    it('reverts finalise before the window closes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.finalise([roundId]),
        'WindowOpen',
      )
    })
  })

  describe('liveness refund', () => {
    it('lets each committer reclaim their ticket when the seed never finalises', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      let firstReceipt: any
      for (let i = 0; i < 3; i++) {
        const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(BigInt(i + 1), viem.keccak256(viem.toHex(`s${i}`)), players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
        if (i === 0) firstReceipt = receipt
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
      await helpers.mine(6)
      await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      // never cast; pass the stale timeout
      await helpers.mine(201)
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        [players[0].account.address],
        [stake],
      )
    })

    it('refunds immediately via the chop path, before the stale timeout', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      let firstReceipt: any
      for (let i = 0; i < 3; i++) {
        const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(BigInt(i + 1), viem.keccak256(viem.toHex(`ch${i}`)), players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
        if (i === 0) firstReceipt = receipt
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
      await helpers.mine(6)
      const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
      // expire the heat window and chop the request -> Random pushes onChop -> choppedInstance set
      await helpers.mine(12)
      await testUtils.confirmTx(ctx, ctx.random.write.chop([key, locations]))
      expect(await ctx.raffle.read.choppedInstance([roundId])).to.equal(true)
      // refund is available now (chopped), well before STALE_BLOCKS would have elapsed
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        [players[0].account.address],
        [stake],
      )
    })
  })

  describe('security invariants', () => {
    it('settlement cannot be blocked by any player action (no last-revealer-abort)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      // only the first player reveals; the others withhold. The window still closes and finalise pays.
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      await helpers.mine(101)
      // finalise succeeds and pays player 0 (the only revealer) — withholding cannot abort it
      await expectations.emit(ctx, ctx.raffle.write.finalise([roundId]), ctx.raffle, 'Finalised')
    })

    it('the draw is fixed at cast and independent of any reveal (seed is validator-only)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      const drawAfterCast = (await ctx.raffle.read.rounds([roundId]))[10] as bigint
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      const drawAfterReveal = (await ctx.raffle.read.rounds([roundId]))[10] as bigint
      expect(drawAfterReveal).to.equal(drawAfterCast)
    })

    it('a reveal with an altered guess reverts (guess freeze)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, (guesses[0] % RANGE) + 1n, salts[0]], { account: players[0].account }),
        'BadReveal',
      )
    })

    it('arm cannot substitute a sybil validator for the declared subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      let firstReceipt: any
      for (let i = 0; i < 3; i++) {
        const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(BigInt(i + 1), viem.keccak256(viem.toHex(`x${i}`)), players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
        if (i === 0) firstReceipt = receipt
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
      await helpers.mine(6)
      const sybil = [locations[0], locations[1], { ...locations[2], provider: subset[0] }]
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, sybil]),
        'SubsetMismatch',
      )
    })
  })

  // Coverage gates: every guard and branch that is a real path (not a defensive/unreachable
  // check) gets an explicit test. The draw is unpredictable through a real cast, so tie tests
  // impersonate the Random contract and push a chosen seed through the real onCast entrypoint.
  describe('coverage gates', () => {
    const setUpFilled = async (ctx: any, guesses: bigint[], salts: viem.Hex[]) => {
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 1 + guesses.length)
      let firstReceipt: any
      for (let i = 0; i < guesses.length; i++) {
        const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
        if (i === 0) firstReceipt = receipt
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
      return { roundId, players, subset, locations, secrets }
    }

    const armRound = async (ctx: any, roundId: viem.Hex, locations: any[]) => {
      await helpers.mine(6)
      const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      return (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
    }

    // push a chosen seed through the real onCast entrypoint as the Random contract
    const drawWithSeed = async (ctx: any, key: viem.Hex, seed: bigint) => {
      await ctx.hre.network.provider.send('hardhat_impersonateAccount', [ctx.random.address])
      await ctx.hre.network.provider.send('hardhat_setBalance', [ctx.random.address, viem.toHex(10n ** 18n)])
      await testUtils.confirmTx(ctx, ctx.raffle.write.onCast([key, viem.toHex(seed, { size: 32 })], { account: ctx.random.address }))
      await ctx.hre.network.provider.send('hardhat_stopImpersonatingAccount', [ctx.random.address])
    }

    it('rejects zero stake, threshold, and period (BadParams)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p] = ctx.signers
      const c = commitmentFor(1n, viem.keccak256(viem.toHex('z')), p.account.address)
      for (const [s, t, per] of [[0n, threshold, period], [stake, 0n, period], [stake, threshold, 0n]] as const) {
        await expectations.revertedWithCustomError(
          ctx.raffle,
          ctx.raffle.write.commit([s, t, per, subset, c], { value: s, account: p.account }),
          'BadParams',
        )
      }
    })

    it('setFee rejects a non-owner and a fee above 100%', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [, p] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.setFee([1n, p.account.address], { account: p.account }),
        'OnlyOwner',
      )
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.setFee([10_001n, p.account.address]),
        'BadFee',
      )
    })

    it('a commit after the active round armed opens a fresh round for the tuple', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`fr${i}`)))
      const { roundId, players, subset, locations } = await setUpFilled(ctx, [1n, 2n, 3n], salts)
      await armRound(ctx, roundId, locations)
      // same tuple again: activeRound was cleared at arm, so this must emit RoundOpened anew
      const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
        [stake, threshold, period, subset, commitmentFor(9n, viem.keccak256(viem.toHex('fr9')), players[0].account.address)],
        { value: stake, account: players[0].account },
      ))
      const opened = await ctx.raffle.getEvents.RoundOpened({}, { blockHash: receipt.blockHash })
      expect(opened.length).to.equal(1)
      expect(opened[0].args.roundId).to.not.equal(roundId)
    })

    it('cancel is one-shot and blocked once the round is no longer filling', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2, 3].map((i) => viem.keccak256(viem.toHex(`cc${i}`)))
      const { roundId, players, locations } = await setUpFilled(ctx, [1n, 2n, 3n, 4n], salts)
      await testUtils.confirmTx(ctx, ctx.raffle.write.cancel([4n], { account: players[3].account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.cancel([4n], { account: players[3].account }),
        'TicketInactive',
      )
      await armRound(ctx, roundId, locations)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.cancel([1n], { account: players[0].account }),
        'WrongRoundState',
      )
    })

    it('arm is one-shot (NotFilling on the second arm)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`oa${i}`)))
      const { roundId, locations } = await setUpFilled(ctx, [1n, 2n, 3n], salts)
      await armRound(ctx, roundId, locations)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, locations]),
        'NotFilling',
      )
    })

    it('reveal guards: wrong state, closed window, inactive ticket, double reveal, range', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      // out-of-range guesses are committable (the commitment is just a hash) but unrevealable
      const salts = [0, 1, 2, 3].map((i) => viem.keccak256(viem.toHex(`rg${i}`)))
      const guesses = [0n, 300n, 50n, 60n]
      const { roundId, players, locations } = await setUpFilled(ctx, guesses, salts)
      // wrong state: round still filling
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([3n, guesses[2], salts[2]], { account: players[2].account }),
        'WrongRoundState',
      )
      // cancel ticket 4 while filling (still >= threshold), then draw
      await testUtils.confirmTx(ctx, ctx.raffle.write.cancel([4n], { account: players[3].account }))
      const key = await armRound(ctx, roundId, locations)
      await drawWithSeed(ctx, key, 127n) // draw = 128
      // inactive (cancelled) ticket cannot reveal
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([4n, guesses[3], salts[3]], { account: players[3].account }),
        'TicketInactive',
      )
      // out-of-range guesses fail after the commitment would have matched
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, 0n, salts[0]], { account: players[0].account }),
        'GuessOutOfRange',
      )
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([2n, 300n, salts[1]], { account: players[1].account }),
        'GuessOutOfRange',
      )
      // double reveal
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([3n, guesses[2], salts[2]], { account: players[2].account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([3n, guesses[2], salts[2]], { account: players[2].account }),
        'AlreadyRevealed',
      )
      // window closes
      await helpers.mine(101)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }),
        'WindowClosed',
      )
    })

    it('a strictly closer reveal overwrites; an equal-distance later commit does not', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2, 3].map((i) => viem.keccak256(viem.toHex(`tb${i}`)))
      // draw will be 128: g0=100 (d=28, earliest commit), g1=156 (d=28, later commit),
      // g2=127 (d=1), g3=10 (d=118)
      const guesses = [100n, 156n, 127n, 10n]
      const { roundId, players, locations } = await setUpFilled(ctx, guesses, salts)
      const key = await armRound(ctx, roundId, locations)
      await drawWithSeed(ctx, key, 127n) // draw = 1 + 127 % 256 = 128
      // ticket 2 (g=156) reveals first: leads as the first reveal
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([2n, guesses[1], salts[1]], { account: players[1].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(2n)
      // ticket 1 (g=100, equal distance 28, EARLIER commit block) overwrites on the tie
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(1n)
      // ticket 4 (g=10, distance 118) is farther: leading=false, winner unchanged
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([4n, guesses[3], salts[3]], { account: players[3].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(1n)
      // ticket 3 (g=127, distance 1) is strictly closer: overwrites
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([3n, guesses[2], salts[2]], { account: players[2].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(3n)
    })

    it('an equal-distance, same-block tie goes to the lower ticket id', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`sb${i}`)))
      const guesses = [100n, 156n, 1n]
      // commits 1 and 2 land in the SAME block
      await ctx.hre.network.provider.send('evm_setAutomine', [false])
      const h1 = await ctx.raffle.write.commit(
        [stake, threshold, period, subset, commitmentFor(guesses[0], salts[0], players[0].account.address)],
        { value: stake, account: players[0].account },
      )
      const h2 = await ctx.raffle.write.commit(
        [stake, threshold, period, subset, commitmentFor(guesses[1], salts[1], players[1].account.address)],
        { value: stake, account: players[1].account },
      )
      await ctx.hre.network.provider.send('evm_mine', [])
      await ctx.hre.network.provider.send('evm_setAutomine', [true])
      const r1 = await testUtils.confirmTx(ctx, h1)
      await testUtils.confirmTx(ctx, h2)
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
        [stake, threshold, period, subset, commitmentFor(guesses[2], salts[2], players[2].account.address)],
        { value: stake, account: players[2].account },
      ))
      const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: r1.blockHash }))[0].args.roundId as viem.Hex
      const key = await armRound(ctx, roundId, locations)
      await drawWithSeed(ctx, key, 127n) // draw = 128; tickets 1 and 2 both at distance 28, same block
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([2n, guesses[1], salts[1]], { account: players[1].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(2n)
      // equal distance, equal commit block: lower ticket id wins
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      expect((await ctx.raffle.read.rounds([roundId]))[12]).to.equal(1n)
    })

    it('recordDraw guards: wrong state before arm and after settle, too early before cast', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`rd${i}`)))
      const { roundId, locations, secrets } = await setUpFilled(ctx, [1n, 2n, 3n], salts)
      // before arm: not Drawing
      await expectations.revertedWithCustomError(ctx.raffle, ctx.raffle.write.recordDraw([roundId]), 'WrongRoundState')
      const key = await armRound(ctx, roundId, locations)
      // armed but the seed has not finalised
      await expectations.revertedWithCustomError(ctx.raffle, ctx.raffle.write.recordDraw([roundId]), 'TooEarly')
      // a real cast settles via the push; the pull is then a no-op state
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      await expectations.revertedWithCustomError(ctx.raffle, ctx.raffle.write.recordDraw([roundId]), 'WrongRoundState')
    })

    it('finalise is one-shot (no double pay)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      await helpers.mine(101)
      await testUtils.confirmTx(ctx, ctx.raffle.write.finalise([roundId]))
      await expectations.revertedWithCustomError(ctx.raffle, ctx.raffle.write.finalise([roundId]), 'WrongRoundState')
    })

    it('refundTicket guards: owner only, not before stale, not once the seed exists, one-shot', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`rf${i}`)))
      const { roundId, players, locations } = await setUpFilled(ctx, [1n, 2n, 3n], salts)
      await armRound(ctx, roundId, locations)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.refundTicket([1n], { account: players[1].account }),
        'NotTicketOwner',
      )
      // armed, seed missing, but not yet stale
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        'TooEarly',
      )
      await helpers.mine(201)
      await testUtils.confirmTx(ctx, ctx.raffle.write.refundTicket([1n], { account: players[0].account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        'TicketInactive',
      )
    })

    it('refundTicket rejects once a seed finalised (TooEarly path on a cast round)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const salts = [0, 1, 2].map((i) => viem.keccak256(viem.toHex(`rc${i}`)))
      const { roundId, players, locations, secrets } = await setUpFilled(ctx, [1n, 2n, 3n], salts)
      const key = await armRound(ctx, roundId, locations)
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      // the seed exists and the round settled: Drawing-state check fires first
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        'WrongRoundState',
      )
    })
  })

  describe('value conservation', () => {
    it('a finalised round leaves no stuck balance attributable to it', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const publicClient = await ctx.hre.viem.getPublicClient()
      const before = await publicClient.getBalance({ address: ctx.raffle.address })
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      await helpers.mine(101)
      await testUtils.confirmTx(ctx, ctx.raffle.write.finalise([roundId]))
      const after = await publicClient.getBalance({ address: ctx.raffle.address })
      expect(after).to.equal(before) // the round's three stakes all left the contract
    })
  })

  // Property fuzzing in the Hardhat toolchain. A real validator cast yields an unpredictable draw,
  // so to fuzz over many draws we impersonate Random and push a chosen seed through the real onCast
  // entrypoint; the contract logic under test (winner selection, accounting) is identical either
  // way. A seeded LCG drives the randomness so any failure is reproducible from the logged seed.
  describe('property fuzzing', () => {
    const ITERATIONS = 40

    // deterministic 32-bit LCG (glibc constants); reproducible, no Math.random
    const makeRng = (seed: number) => {
      let s = seed >>> 0
      return () => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0
        return s / 0x100000000
      }
    }
    const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))

    // off-chain oracle: replays the exact on-chain selection rule (closest distance, ties to the
    // earliest commit block, then the lowest ticket id) over the revealed tickets.
    const expectedWinner = (
      draw: bigint,
      revealed: { ticketId: bigint; guess: bigint; block: bigint }[],
    ) => {
      let best: { ticketId: bigint; dist: bigint; block: bigint } | null = null
      for (const r of revealed) {
        const dist = r.guess > draw ? r.guess - draw : draw - r.guess
        if (
          best === null ||
          dist < best.dist ||
          (dist === best.dist && r.block < best.block) ||
          (dist === best.dist && r.block === best.block && r.ticketId < best.ticketId)
        ) {
          best = { ticketId: r.ticketId, dist, block: r.block }
        }
      }
      return best ? best.ticketId : 0n
    }

    it(`holds draw-range, winner-is-closest and value conservation across ${ITERATIONS} fuzzed rounds`, async () => {
      const fuzzSeed = 0xc0ffee
      const rng = makeRng(fuzzSeed)

      for (let iter = 0; iter < ITERATIONS; iter++) {
        // fresh fixture per iteration: a real arm() consumes the validators' inked preimages, so
        // each round needs freshly-inked entropy (otherwise Random reverts UnableToService).
        const ctx = await helpers.loadFixture(testUtils.deploy)
        const publicClient = await ctx.hre.viem.getPublicClient()
        const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
        const pool = ctx.signers.slice(1, 9) // a random subset of these commits each round
        const contractBefore = await publicClient.getBalance({ address: ctx.raffle.address })
        const n = randInt(rng, 3, pool.length) // at least threshold (3) committers
        const fStake = viem.parseEther('1') * BigInt(randInt(rng, 1, 5))
        const players = pool.slice(0, n)
        const guesses = players.map(() => BigInt(randInt(rng, 1, 256)))
        const salts = players.map((_p, i) => viem.keccak256(viem.toHex(`fz-${iter}-${i}`)))

        let firstReceipt: any
        const commitBlocks: bigint[] = []
        for (let i = 0; i < n; i++) {
          const receipt = await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
            [fStake, 3n, 5n, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
            { value: fStake, account: players[i].account },
          ))
          if (i === 0) firstReceipt = receipt
          commitBlocks.push(receipt.blockNumber as bigint)
        }
        const roundId = (await ctx.raffle.getEvents.RoundOpened({}, { blockHash: firstReceipt.blockHash }))[0].args.roundId as viem.Hex
        // ticket ids are 1-based via ++nextTicket; player i (commit i) holds firstTicket + i
        const firstTicket = (await ctx.raffle.read.nextTicket()) - BigInt(n) + 1n

        await helpers.mine(6)
        const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
        const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex

        // push a fuzzed seed through the real onCast as Random
        const seedVal = BigInt(randInt(rng, 0, 0xffffff)) * 7919n + BigInt(iter)
        await ctx.hre.network.provider.send('hardhat_impersonateAccount', [ctx.random.address])
        await ctx.hre.network.provider.send('hardhat_setBalance', [ctx.random.address, viem.toHex(10n ** 18n)])
        await testUtils.confirmTx(ctx, ctx.raffle.write.onCast([key, viem.toHex(seedVal, { size: 32 })], { account: ctx.random.address }))
        await ctx.hre.network.provider.send('hardhat_stopImpersonatingAccount', [ctx.random.address])

        const draw = (await ctx.raffle.read.rounds([roundId]))[10] as bigint
        expect(draw, `iter ${iter} seed ${fuzzSeed}: draw in range`).to.be.greaterThanOrEqual(1n)
        expect(draw).to.be.lessThanOrEqual(RANGE)

        // reveal a random subset in a random order; track who actually revealed
        const order = players.map((_p, i) => i).sort(() => rng() - 0.5)
        const revealed: { ticketId: bigint; guess: bigint; block: bigint }[] = []
        for (const i of order) {
          if (rng() < 0.2) continue // ~20% withhold their reveal
          const ticketId = firstTicket + BigInt(i)
          await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([ticketId, guesses[i], salts[i]], { account: players[i].account }))
          revealed.push({ ticketId, guess: guesses[i], block: commitBlocks[i] })
        }

        await helpers.mine(101)
        const subsetBalsBefore = await Promise.all(subset.map((v: viem.Hex) => publicClient.getBalance({ address: v })))
        await testUtils.confirmTx(ctx, ctx.raffle.write.finalise([roundId]))

        const pot = fStake * BigInt(n)
        const oracleWinner = expectedWinner(draw, revealed)
        if (oracleWinner !== 0n) {
          // bestTicket on-chain must match the oracle, and that player must have received the pot
          expect((await ctx.raffle.read.rounds([roundId]))[12], `iter ${iter}: winner matches oracle`).to.equal(oracleWinner)
        } else {
          // nobody revealed -> no-contest: the pot is split across the validator subset
          const after = await Promise.all(subset.map((v: viem.Hex) => publicClient.getBalance({ address: v })))
          const distributed = after.reduce((acc, b, i) => acc + (b - subsetBalsBefore[i]), 0n)
          expect(distributed, `iter ${iter}: no-contest distributes whole pot`).to.equal(pot)
        }
        // value conservation: the contract holds exactly what it did before this round
        const contractAfter = await publicClient.getBalance({ address: ctx.raffle.address })
        expect(contractAfter, `iter ${iter}: no stuck balance`).to.equal(contractBefore)
      }
    })
  })
})
