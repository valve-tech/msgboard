import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { privateKeyToAccount } from 'viem/accounts'
import * as expectations from './expectations'
import { makeDomain, signState as coreSignState, type ChannelState, type ChannelDomain } from '@msgboard/zk-cards-core'

const STAKE = viem.parseEther('1')
const CLOCK = 60n
const DECK_KEY_A = [1n, 2n] as const
const DECK_KEY_B = [3n, 4n] as const

const deployZk = async () => {
  const zk = await hre.viem.deployContract('ZkTable')
  const rules = await hre.viem.deployContract('MockGameRules')
  const signers = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()
  const domain = makeDomain(await publicClient.getChainId(), zk.address)
  return { zk, rules, signers, publicClient, domain, hre }
}

type ZkContext = Awaited<ReturnType<typeof deployZk>>
// expectations helpers only touch ctx.hre
const asCtx = (ctx: ZkContext) => ctx as any

const createTable = async (
  ctx: ZkContext,
  opts: { value?: bigint; joinStake?: bigint; clock?: bigint; channelKey?: viem.Hex } = {},
) => {
  const [a] = ctx.signers
  const hash = await ctx.zk.write.create(
    [
      ctx.rules.address,
      opts.joinStake ?? STAKE,
      opts.clock ?? CLOCK,
      opts.channelKey ?? viem.zeroAddress,
      DECK_KEY_A as unknown as [bigint, bigint],
    ],
    { value: opts.value ?? STAKE, account: a!.account },
  )
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.zk.abi, eventName: 'TableCreated' })
  return { tableId: created!.args.tableId, hash, receipt }
}

const joinTable = async (ctx: ZkContext, tableId: viem.Hex, opts: { value?: bigint; channelKey?: viem.Hex } = {}) => {
  const [, b] = ctx.signers
  return await ctx.zk.write.join(
    [tableId, opts.channelKey ?? viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint]],
    { value: opts.value ?? STAKE, account: b!.account },
  )
}

const mkState = (tableId: viem.Hex, over: Partial<ChannelState> = {}): ChannelState => ({
  tableId,
  nonce: 1n,
  balanceA: viem.parseEther('1.5'),
  balanceB: viem.parseEther('0.5'),
  pot: 0n,
  deckCommitment: viem.keccak256(viem.toHex('deck')),
  phase: 1,
  gameStateHash: viem.keccak256(viem.toHex('game-state')),
  ...over,
})

// Adapts viem signers to the package's StateSigner shape: wallet clients hold their
// address at account.address, local accounts expose it top-level; both signTypedData.
type TypedDataSigner = {
  signTypedData(args: any): Promise<viem.Hex>
  address?: viem.Hex
  account?: { address: viem.Hex }
}
const signState = (signer: TypedDataSigner, domain: ChannelDomain, state: ChannelState) =>
  coreSignState(
    {
      address: (signer.address ?? signer.account!.address) as viem.Hex,
      signTypedData: (args) => signer.signTypedData(args),
    },
    domain,
    state,
  )

// table tuple indices (struct order in ZkTable.Table)
const PLAYER_B = 1
const ESCROW_A = 4
const ESCROW_B = 5
const STATUS = 9
const enum Status { None, Created, Live, Disputed, Settled, Cancelled }

describe('ZkTable', () => {
  describe('create', () => {
    it('escrows the stake, records the table, and emits TableCreated', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId, hash } = await createTable(ctx)
      await expectations.emit(asCtx(ctx), hash, ctx.zk, 'TableCreated', {
        tableId,
        playerA: viem.getAddress(a!.account!.address),
        rules: viem.getAddress(ctx.rules.address),
        escrow: STAKE,
        joinStake: STAKE,
        clockBlocks: CLOCK,
      })
      const table = await ctx.zk.read.tables([tableId])
      expect(table[ESCROW_A]).to.equal(STAKE)
      expect(table[STATUS]).to.equal(Status.Created)
      expect(await ctx.publicClient.getBalance({ address: ctx.zk.address })).to.equal(STAKE)
    })

    it('issues distinct tableIds across creates', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId: first } = await createTable(ctx)
      const { tableId: second } = await createTable(ctx)
      expect(first).to.not.equal(second)
    })

    it('rejects zero escrow', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.create(
          [ctx.rules.address, STAKE, CLOCK, viem.zeroAddress, DECK_KEY_A as unknown as [bigint, bigint]],
          { value: 0n },
        ),
        'WrongValue',
      )
    })

    it('rejects a clock below MIN_CLOCK_BLOCKS', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.create(
          [ctx.rules.address, STAKE, 10n, viem.zeroAddress, DECK_KEY_A as unknown as [bigint, bigint]],
          { value: STAKE },
        ),
        'BadClock',
      )
    })

    it('rejects a clock above MAX_CLOCK_BLOCKS', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.create(
          [ctx.rules.address, STAKE, 99999n, viem.zeroAddress, DECK_KEY_A as unknown as [bigint, bigint]],
          { value: STAKE },
        ),
        'BadClock',
      )
    })

    it('rejects an EOA rules address', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, b] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.create(
          [b!.account!.address, STAKE, CLOCK, viem.zeroAddress, DECK_KEY_A as unknown as [bigint, bigint]],
          { value: STAKE },
        ),
        'BadRules',
      )
    })
  })

  describe('join', () => {
    it('rejects a stake that is not exactly joinStake', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId } = await createTable(ctx)
      await expectations.revertedWithCustomError(
        ctx.zk,
        joinTable(ctx, tableId, { value: STAKE + 1n }),
        'WrongValue',
      )
    })

    it('rejects the creator joining their own table', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint]], {
          value: STAKE,
          account: a!.account,
        }),
        'NotPlayer',
      )
    })

    it('moves the table to Live, records B, and emits TableJoined', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, b] = ctx.signers
      const { tableId } = await createTable(ctx)
      await expectations.emit(asCtx(ctx), joinTable(ctx, tableId), ctx.zk, 'TableJoined', {
        tableId,
        playerB: viem.getAddress(b!.account!.address),
      })
      const table = await ctx.zk.read.tables([tableId])
      expect(table[PLAYER_B]).to.equal(viem.getAddress(b!.account!.address))
      expect(table[ESCROW_B]).to.equal(STAKE)
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('rejects a second join', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, , c] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint]], {
          value: STAKE,
          account: c!.account,
        }),
        'BadStatus',
      )
    })

    // Covers the `keyB == t.keyA` operand of the seat-collision guard (the wallet-collision
    // `keyB == t.playerA` operand is already covered by the creator-self-join test). Create with an
    // explicit channelKey K (so keyA = K, distinct from playerA), then have B join requesting the
    // same K: keyB resolves to K == keyA and join must reject.
    it('rejects a join whose channelKey collides with keyA', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, , k] = ctx.signers
      const channelKey = viem.getAddress(k!.account!.address)
      const { tableId } = await createTable(ctx, { channelKey })
      await expectations.revertedWithCustomError(
        ctx.zk,
        joinTable(ctx, tableId, { channelKey }),
        'NotPlayer',
      )
    })
  })

  describe('cancel', () => {
    it('rejects anyone but the creator', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, b] = ctx.signers
      const { tableId } = await createTable(ctx)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.cancel([tableId], { account: b!.account }),
        'NotPlayer',
      )
    })

    it('rejects cancel once the table is Live', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.cancel([tableId], { account: a!.account }),
        'BadStatus',
      )
    })

    it('refunds the full escrow to the creator', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.cancel([tableId], { account: a!.account }),
        [a!, ctx.zk.address],
        [STAKE, -STAKE],
      )
      const table = await ctx.zk.read.tables([tableId])
      expect(table[STATUS]).to.equal(Status.Cancelled)
      expect(table[ESCROW_A]).to.equal(0n)
    })

    it('rejects a second cancel', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await ctx.zk.write.cancel([tableId], { account: a!.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.cancel([tableId], { account: a!.account }),
        'BadStatus',
      )
    })
  })

  describe('topUp', () => {
    it('bumps seat A escrow and emits ToppedUp', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const amount = viem.parseEther('0.3')
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.topUp([tableId], { value: amount, account: a!.account }),
        ctx.zk,
        'ToppedUp',
        { tableId, seat: 1, amount },
      )
      const table = await ctx.zk.read.tables([tableId])
      expect(table[ESCROW_A]).to.equal(STAKE + amount)
      expect(table[ESCROW_B]).to.equal(STAKE)
    })

    it('bumps seat B escrow', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, b] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const amount = viem.parseEther('0.7')
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.topUp([tableId], { value: amount, account: b!.account }),
        ctx.zk,
        'ToppedUp',
        { tableId, seat: 2, amount },
      )
      const table = await ctx.zk.read.tables([tableId])
      expect(table[ESCROW_A]).to.equal(STAKE)
      expect(table[ESCROW_B]).to.equal(STAKE + amount)
    })

    it('rejects strangers', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, , c] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId], { value: STAKE, account: c!.account }),
        'NotPlayer',
      )
    })

    it('rejects a zero-value top-up', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId], { value: 0n, account: a!.account }),
        'WrongValue',
      )
    })

    it('rejects top-up before the table is Live', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId], { value: STAKE, account: a!.account }),
        'BadStatus',
      )
    })
  })

  describe('settle', () => {
    // Live table with 2 ETH total escrow, plus a default final state splitting it 1.5/0.5.
    const liveTable = async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const [a, b] = ctx.signers
      const state = mkState(tableId)
      const sigA = await signState(a!, ctx.domain, state)
      const sigB = await signState(b!, ctx.domain, state)
      return { ...ctx, tableId, a: a!, b: b!, state, sigA, sigB }
    }

    it('pays out a co-signed final state and marks the table Settled', async () => {
      const ctx = await liveTable()
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.a.account }),
        [ctx.a, ctx.b, ctx.zk.address],
        [ctx.state.balanceA, ctx.state.balanceB, -(ctx.state.balanceA + ctx.state.balanceB)],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
      expect(table[ESCROW_A]).to.equal(0n)
      expect(table[ESCROW_B]).to.equal(0n)
    })

    // Covers _payout's one-sided branch: a final state handing the whole escrow to one seat and
    // zero to the other. balanceA == 0 exercises the `toA > 0` false side (no transfer to A);
    // B receives the full escrow. (The mirror — toB == 0 — is covered in the dispute-timeout suite.)
    it('settles a one-sided final state — full escrow to B, nothing to A', async () => {
      const ctx = await liveTable()
      const oneSided = mkState(ctx.tableId, {
        balanceA: 0n,
        balanceB: viem.parseEther('2'),
        pot: 0n,
      })
      const sigA = await signState(ctx.a, ctx.domain, oneSided)
      const sigB = await signState(ctx.b, ctx.domain, oneSided)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.settle([ctx.tableId, oneSided, sigA, sigB], { account: ctx.b.account }),
        [ctx.a, ctx.b, ctx.zk.address],
        [0n, oneSided.balanceB, -oneSided.balanceB],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    it('emits TableSettled with the payouts', async () => {
      const ctx = await liveTable()
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.b.account }),
        ctx.zk,
        'TableSettled',
        { tableId: ctx.tableId, payoutA: ctx.state.balanceA, payoutB: ctx.state.balanceB },
      )
    })

    it('rejects a sigB from the wrong key', async () => {
      const ctx = await liveTable()
      const [, , stranger] = ctx.signers
      const tamperedSigB = await signState(stranger!, ctx.domain, ctx.state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, tamperedSigB], { account: ctx.a.account }),
        'BadSig',
      )
    })

    it('rejects a sigA from the wrong key', async () => {
      const ctx = await liveTable()
      const [, , stranger] = ctx.signers
      const tamperedSigA = await signState(stranger!, ctx.domain, ctx.state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, tamperedSigA, ctx.sigB], { account: ctx.b.account }),
        'BadSig',
      )
    })

    it('a top-up invalidates states signed against the old escrow total', async () => {
      const ctx = await liveTable() // default state sums to the pre-top-up 2 ETH escrow
      const amount = viem.parseEther('0.5')
      await ctx.zk.write.topUp([ctx.tableId], { value: amount, account: ctx.a.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.a.account }),
        'ConservationViolated',
      )
      const fresh = mkState(ctx.tableId, {
        nonce: 2n,
        balanceA: viem.parseEther('2'),
        balanceB: viem.parseEther('0.5'),
      })
      const sigA = await signState(ctx.a, ctx.domain, fresh)
      const sigB = await signState(ctx.b, ctx.domain, fresh)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.settle([ctx.tableId, fresh, sigA, sigB], { account: ctx.a.account }),
        [ctx.a, ctx.b],
        [fresh.balanceA, fresh.balanceB],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    it('rejects a final state still carrying a pot', async () => {
      const ctx = await liveTable()
      // balances + pot == escrow so conservation passes and the pot check fires
      const state = mkState(ctx.tableId, {
        balanceA: viem.parseEther('1'),
        balanceB: viem.parseEther('0.5'),
        pot: viem.parseEther('0.5'),
      })
      const sigA = await signState(ctx.a, ctx.domain, state)
      const sigB = await signState(ctx.b, ctx.domain, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, state, sigA, sigB], { account: ctx.a.account }),
        'PotNotZero',
      )
    })

    it('rejects balances that do not conserve the escrow', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId, {
        balanceA: viem.parseEther('1'),
        balanceB: viem.parseEther('0.5'),
        pot: 0n,
      })
      const sigA = await signState(ctx.a, ctx.domain, state)
      const sigB = await signState(ctx.b, ctx.domain, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, state, sigA, sigB], { account: ctx.a.account }),
        'ConservationViolated',
      )
    })

    it('rejects a non-final phase', async () => {
      const ctx = await liveTable()
      await ctx.rules.write.setFinalAll([false])
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.a.account }),
        'NotFinal',
      )
    })

    it('rejects strangers', async () => {
      const ctx = await liveTable()
      const [, , stranger] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: stranger!.account }),
        'NotPlayer',
      )
    })

    it('rejects a state bound to a different table', async () => {
      const ctx = await liveTable()
      const state = mkState(viem.keccak256(viem.toHex('some-other-table')))
      const sigA = await signState(ctx.a, ctx.domain, state)
      const sigB = await signState(ctx.b, ctx.domain, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, state, sigA, sigB], { account: ctx.a.account }),
        'WrongTable',
      )
    })

    it('rejects settling twice', async () => {
      const ctx = await liveTable()
      await ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.a.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: ctx.a.account }),
        'BadStatus',
      )
    })

    it('recovers against the channel keys, not the wallets', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a, b] = ctx.signers
      const keyA = privateKeyToAccount('0x' + '11'.repeat(32) as viem.Hex)
      const keyB = privateKeyToAccount('0x' + '22'.repeat(32) as viem.Hex)
      const { tableId } = await createTable(ctx, { channelKey: keyA.address })
      await joinTable(ctx, tableId, { channelKey: keyB.address })
      const state = mkState(tableId)
      // wallet signatures must NOT satisfy the channel-key recovery
      const walletSigA = await signState(a!, ctx.domain, state)
      const walletSigB = await signState(b!, ctx.domain, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([tableId, state, walletSigA, walletSigB], { account: a!.account }),
        'BadSig',
      )
      const sigA = await signState(keyA, ctx.domain, state)
      const sigB = await signState(keyB, ctx.domain, state)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.settle([tableId, state, sigA, sigB], { account: a!.account }),
        [a!, b!],
        [state.balanceA, state.balanceB],
      )
      const table = await ctx.zk.read.tables([tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })
  })
})
