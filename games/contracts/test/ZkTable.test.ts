import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { privateKeyToAccount } from 'viem/accounts'
import * as expectations from './expectations'
import { makeDomain, signState as coreSignState, type ChannelState, type ChannelDomain } from '@msgboard/zk-cards-core'
import { deployZkTable, makeX402Domain, buildCreateAuth, buildJoinAuth, buildTopUpAuth, type DepositAuth } from './x402'

const STAKE = viem.parseEther('1')
const CLOCK = 60n
const DECK_KEY_A = [1n, 2n] as const
const DECK_KEY_B = [3n, 4n] as const
const MINT_AMOUNT = viem.parseEther('1000')

const deployZk = async () => {
  // ZkTable's constructor now takes the x402 wrapper-factory address (see ZkTable.sol's
  // IWrapperFactory) — zeroAddress skips the create()-time clone-check, matching the Foundry
  // unit suites (which fund via the same bare MockX402, not a real wrapper clone).
  const zk = await deployZkTable(viem.zeroAddress)
  const rules = await hre.viem.deployContract('MockGameRules')
  const token = await hre.viem.deployContract('MockX402')
  const signers = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  const domain = makeDomain(chainId, zk.address)
  const x402Domain = makeX402Domain(chainId, token.address)
  await Promise.all(signers.map((s) => token.write.mint([s.account!.address, MINT_AMOUNT])))
  return { zk, rules, token, signers, publicClient, domain, x402Domain, hre }
}

type ZkContext = Awaited<ReturnType<typeof deployZk>>
// expectations helpers only touch ctx.hre
const asCtx = (ctx: ZkContext) => ctx as any

// A garbage (unsigned) DepositAuth for revert-path tests whose failure occurs BEFORE `_pull` is
// ever reached (WrongValue/BadClock/BadRules/BadStatus/NotPlayer/... — every one of
// create/join/topUp's OWN guards runs before the token pull, per ZkTable.sol's CEI reorder).
// Using this where a real signature is actually required would either mask the guard under test
// behind the wrapper's own InvalidSignature, or (for a happy path) simply fail to pull funds.
const dummyAuth = (from: viem.Hex): DepositAuth => ({ from, validBefore: 0n, salt: viem.zeroHash, sig: '0x' })

const createTable = async (
  ctx: ZkContext,
  opts: { buyIn?: bigint; joinStake?: bigint; clock?: bigint; channelKey?: viem.Hex; badAuth?: boolean } = {},
) => {
  const [a] = ctx.signers
  const buyIn = opts.buyIn ?? STAKE
  const rules = ctx.rules.address
  const joinStake = opts.joinStake ?? STAKE
  const clockBlocks = opts.clock ?? CLOCK
  const channelKey = opts.channelKey ?? viem.zeroAddress
  const auth = opts.badAuth
    ? dummyAuth(a!.account!.address)
    : await buildCreateAuth(ctx.zk, ctx.token.address, ctx.x402Domain, a!, {
        rules,
        buyIn,
        joinStake,
        clockBlocks,
        channelKey,
        deckKey: DECK_KEY_A,
      })
  const hash = await ctx.zk.write.create([ctx.token.address, buyIn, rules, joinStake, clockBlocks, channelKey, DECK_KEY_A as unknown as [bigint, bigint], auth])
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.zk.abi, eventName: 'TableCreated' })
  return { tableId: created!.args.tableId, hash, receipt }
}

const joinTable = async (
  ctx: ZkContext,
  tableId: viem.Hex,
  opts: { stake?: bigint; channelKey?: viem.Hex; badAuth?: boolean } = {},
) => {
  const [, b] = ctx.signers
  const stake = opts.stake ?? STAKE
  const channelKey = opts.channelKey ?? viem.zeroAddress
  const auth = opts.badAuth
    ? dummyAuth(b!.account!.address)
    : await buildJoinAuth(ctx.zk, ctx.x402Domain, b!, { tableId, stake, channelKey, deckKey: DECK_KEY_B })
  return await ctx.zk.write.join([tableId, channelKey, DECK_KEY_B as unknown as [bigint, bigint], auth])
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
  jointKeyCommit: ('0x' + '00'.repeat(32)) as viem.Hex,
  shuffleRoot: ('0x' + '00'.repeat(32)) as viem.Hex,
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
      expect(await ctx.token.read.balanceOf([ctx.zk.address])).to.equal(STAKE)
    })

    it('issues distinct tableIds across creates', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const { tableId: first } = await createTable(ctx)
      // A distinct buyIn so the second create's auth nonce (which does NOT include a per-call
      // counter, only the signed terms + salt) doesn't collide with the first's already-burned one.
      const { tableId: second } = await createTable(ctx, { buyIn: STAKE * 2n })
      expect(first).to.not.equal(second)
    })

    it('rejects zero escrow', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        createTable(ctx, { buyIn: 0n, badAuth: true }),
        'WrongValue',
      )
    })

    it('rejects a clock below MIN_CLOCK_BLOCKS', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        createTable(ctx, { clock: 10n, badAuth: true }),
        'BadClock',
      )
    })

    it('rejects a clock above MAX_CLOCK_BLOCKS', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      await expectations.revertedWithCustomError(
        ctx.zk,
        createTable(ctx, { clock: 99999n, badAuth: true }),
        'BadClock',
      )
    })

    it('rejects an EOA rules address', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const auth = dummyAuth(a!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.create([
          ctx.token.address,
          STAKE,
          ctx.signers[1]!.account!.address, // an EOA, not a deployed IGameRules
          STAKE,
          CLOCK,
          viem.zeroAddress,
          DECK_KEY_A as unknown as [bigint, bigint],
          auth,
        ]),
        'BadRules',
      )
    })
  })

  describe('join', () => {
    // join() no longer takes a caller-supplied stake amount at all — it always pulls exactly
    // t.joinStake from contract state, never from calldata (see ZkTable.sol's join()). The old
    // msg.value-mismatch WrongValue check is gone along with msg.value itself; a joiner who
    // signs an authorization for a DIFFERENT value than joinStake instead fails at the wrapper's
    // own signature check (the value is baked into the signed EIP-712 struct).
    it('rejects a join-auth signed for the wrong amount', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [, b] = ctx.signers
      const { tableId } = await createTable(ctx)
      const badAuth = await buildJoinAuth(ctx.zk, ctx.x402Domain, b!, {
        tableId,
        stake: STAKE + 1n, // signed for a DIFFERENT amount than the real joinStake (STAKE)
        channelKey: viem.zeroAddress,
        deckKey: DECK_KEY_B,
      })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint], badAuth]),
        'InvalidSignature',
      )
    })

    it('rejects the creator joining their own table', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      const auth = dummyAuth(a!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint], auth]),
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
      const auth = dummyAuth(c!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, viem.zeroAddress, DECK_KEY_B as unknown as [bigint, bigint], auth]),
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
      const [, b] = ctx.signers
      const auth = dummyAuth(b!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.join([tableId, channelKey, DECK_KEY_B as unknown as [bigint, bigint], auth]),
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
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
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
    const topUp = async (ctx: ZkContext, tableId: viem.Hex, signer: any, amount: bigint) => {
      const auth = await buildTopUpAuth(ctx.zk, ctx.x402Domain, signer, { tableId, amount })
      return await ctx.zk.write.topUp([tableId, amount, auth])
    }

    it('bumps seat A escrow and emits ToppedUp', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const amount = viem.parseEther('0.3')
      await expectations.emit(
        asCtx(ctx),
        topUp(ctx, tableId, a!, amount),
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
        topUp(ctx, tableId, b!, amount),
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
      const auth = dummyAuth(c!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId, STAKE, auth]),
        'NotPlayer',
      )
    })

    it('rejects a zero-value top-up', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      await joinTable(ctx, tableId)
      const auth = dummyAuth(a!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId, 0n, auth]),
        'WrongValue',
      )
    })

    it('rejects top-up before the table is Live', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a] = ctx.signers
      const { tableId } = await createTable(ctx)
      const auth = dummyAuth(a!.account!.address)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.topUp([tableId, STAKE, auth]),
        'BadStatus',
      )
    })
  })

  describe('settle', () => {
    // Live table with 2 ETH-equivalent total escrow, plus a default final state splitting it 1.5/0.5.
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
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
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
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
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
      const ctx = await liveTable() // default state sums to the pre-top-up 2 ETH-equivalent escrow
      const amount = viem.parseEther('0.5')
      const topUpAuth = await buildTopUpAuth(ctx.zk, ctx.x402Domain, ctx.a, { tableId: ctx.tableId, amount })
      await ctx.zk.write.topUp([ctx.tableId, amount, topUpAuth], { account: ctx.a.account })
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
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
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

    // settle() is now fully permissionless (x402 conversion — see ZkTable.sol's header): the
    // payout is determined entirely by the two verified channel-key signatures, conservation,
    // isFinal, pot==0, and nonce monotonicity. msg.sender's identity is never consulted, so a
    // stranger (a relayer/watchtower) submitting the co-signed final on the players' behalf
    // succeeds and still pays the REAL players, not the stranger.
    it('is permissionless: a stranger can submit it, and it still pays the real players', async () => {
      const ctx = await liveTable()
      const [, , stranger] = ctx.signers
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
        ctx.zk.write.settle([ctx.tableId, ctx.state, ctx.sigA, ctx.sigB], { account: stranger!.account }),
        [ctx.a, ctx.b, stranger!],
        [ctx.state.balanceA, ctx.state.balanceB, 0n],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
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
      await expectations.changeTokenBalances(
        asCtx(ctx),
        ctx.token,
        ctx.zk.write.settle([tableId, state, sigA, sigB], { account: a!.account }),
        [a!, b!],
        [state.balanceA, state.balanceB],
      )
      const table = await ctx.zk.read.tables([tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })
  })
})
