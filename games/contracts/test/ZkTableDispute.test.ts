import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import { makeDomain, signState as coreSignState, type ChannelState, type ChannelDomain } from '@msgboard/zk-cards-core'
import revealFixture from './fixtures/zypher-reveal-snark.json'

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    __SOLIDITY_COVERAGE_RUNNING: boolean
  }
}

// Place a contract's compiled runtime bytecode directly at `address` via hardhat_setCode.
// RevealVerifier's runtime code (~30KB) exceeds EIP-170's 24576-byte deployed-code limit, so it
// cannot be deployed by a normal tx under the default network (allowUnlimitedContractSize:false).
// setCode writes runtime code directly, bypassing the check, so the real-verifier dispute tests
// run under plain `hardhat test` without relaxing the global size limit (which the Random suite
// depends on staying enforced). Under solidity-coverage the size limit is off and the verifier
// must be deployed so it is instrumented, so callers branch on __SOLIDITY_COVERAGE_RUNNING.
const REVEAL_ADDR = viem.getAddress('0x00000000000000000000000000000000000ce523')
const deployOrEtchRevealVerifier = async (): Promise<viem.Hex> => {
  if (hre.__SOLIDITY_COVERAGE_RUNNING) {
    const reveal = await hre.viem.deployContract('RevealVerifier')
    return reveal.address
  }
  const artifact = await hre.artifacts.readArtifact('RevealVerifier')
  const testClient = await hre.viem.getTestClient()
  await testClient.setCode({ address: REVEAL_ADDR, bytecode: artifact.deployedBytecode as viem.Hex })
  return REVEAL_ADDR
}

// The generated ZkTable binding types `zkproof` as a fixed 8-tuple (uint256[8]); build proof
// args as this rather than bigint[] so tsc accepts them.
type Proof8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
const ZERO_PROOF: Proof8 = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]

const STAKE = viem.parseEther('1')
const CLOCK = 60n
const DECK_KEY_A = [1n, 2n] as const
const DECK_KEY_B = [3n, 4n] as const

// MockGameRules.hashGameState = keccak256(gameState); pick a preimage and pin the hash.
const GAME_STATE = viem.toHex('hilo-game-state')
const GAME_STATE_HASH = viem.keccak256(GAME_STATE)
const DECK_COMMITMENT = viem.keccak256(viem.toHex('deck'))

const deployZk = async () => {
  const zk = await hre.viem.deployContract('ZkTable')
  const rules = await hre.viem.deployContract('MockGameRules')
  const verifier = await hre.viem.deployContract('MockRevealVerifier')
  await rules.write.setRevealVerifier([verifier.address])
  const signers = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()
  const domain = makeDomain(await publicClient.getChainId(), zk.address)
  return { zk, rules, verifier, signers, publicClient, domain, hre }
}

type ZkContext = Awaited<ReturnType<typeof deployZk>>
const asCtx = (ctx: ZkContext) => ctx as any

const createTable = async (
  ctx: ZkContext,
  opts: { rules?: viem.Hex; deckKeyA?: readonly [bigint, bigint] } = {},
) => {
  const [a] = ctx.signers
  const hash = await ctx.zk.write.create(
    [
      opts.rules ?? ctx.rules.address,
      STAKE,
      CLOCK,
      viem.zeroAddress,
      (opts.deckKeyA ?? DECK_KEY_A) as unknown as [bigint, bigint],
    ],
    { value: STAKE, account: a!.account },
  )
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  const [created] = viem.parseEventLogs({ logs: receipt.logs, abi: ctx.zk.abi, eventName: 'TableCreated' })
  return created!.args.tableId
}

const joinTable = async (
  ctx: ZkContext,
  tableId: viem.Hex,
  opts: { deckKeyB?: readonly [bigint, bigint] } = {},
) => {
  const [, b] = ctx.signers
  await ctx.zk.write.join(
    [tableId, viem.zeroAddress, (opts.deckKeyB ?? DECK_KEY_B) as unknown as [bigint, bigint]],
    { value: STAKE, account: b!.account },
  )
}

const mkState = (tableId: viem.Hex, over: Partial<ChannelState> = {}): ChannelState => ({
  tableId,
  nonce: 1n,
  balanceA: viem.parseEther('1.2'),
  balanceB: viem.parseEther('0.3'),
  pot: viem.parseEther('0.5'),
  deckCommitment: DECK_COMMITMENT,
  phase: 1,
  gameStateHash: GAME_STATE_HASH,
  ...over,
})

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

const cosign = async (ctx: ZkContext, state: ChannelState) => {
  const [a, b] = ctx.signers
  const sigA = await signState(a!, ctx.domain, state)
  const sigB = await signState(b!, ctx.domain, state)
  return { sigA, sigB }
}

// table tuple indices (struct order in ZkTable.Table)
const STATUS = 9
const DISPUTE_DEADLINE = 12
const DISPUTANT = 13
const DEMAND_KIND = 14
const enum Status { None, Created, Live, Disputed, Settled, Cancelled }
const DEMAND_MOVE = 1
const DEMAND_SHARE = 2

// A Live table with 2 ETH escrow, plus a contested state that conserves it.
const liveTable = async () => {
  const ctx = await helpers.loadFixture(deployZk)
  const tableId = await createTable(ctx)
  await joinTable(ctx, tableId)
  const [a, b] = ctx.signers
  return { ...ctx, tableId, a: a!, b: b! }
}

describe('ZkTable dispute machine', () => {
  describe('disputeSetup', () => {
    it('opens a setup dispute with deadline now + clockBlocks', async () => {
      const ctx = await liveTable()
      const blockNo = await ctx.publicClient.getBlockNumber()
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.disputeSetup([ctx.tableId], { account: ctx.a.account }),
        ctx.zk,
        'SetupDisputeOpened',
        { tableId: ctx.tableId, disputant: 1, deadline: blockNo + 1n + CLOCK },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Disputed)
      expect(table[DISPUTANT]).to.equal(1)
      expect(table[DEMAND_KIND]).to.equal(0)
      expect(table[DISPUTE_DEADLINE]).to.equal(blockNo + 1n + CLOCK)
    })

    it('respondWithState with a co-signed nonce-0 state clears to Live and checkpoints', async () => {
      const ctx = await liveTable()
      await ctx.zk.write.disputeSetup([ctx.tableId], { account: ctx.a.account })
      const state = mkState(ctx.tableId, { nonce: 0n })
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.respondWithState([ctx.tableId, state, sigA, sigB], { account: ctx.b.account }),
        ctx.zk,
        'DisputeAnsweredWithState',
        { tableId: ctx.tableId, nonce: 0n },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('timeout refunds BOTH escrows in full', async () => {
      const ctx = await liveTable()
      await ctx.zk.write.disputeSetup([ctx.tableId], { account: ctx.a.account })
      await helpers.mine(Number(CLOCK) + 1)
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        ctx.zk,
        'SetupDisputeRefunded',
        { tableId: ctx.tableId },
      )
    })

    it('timeout refund moves the exact escrow balances', async () => {
      const ctx = await liveTable()
      await ctx.zk.write.disputeSetup([ctx.tableId], { account: ctx.a.account })
      await helpers.mine(Number(CLOCK) + 1)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        [ctx.a, ctx.b, ctx.zk.address],
        [STAKE, STAKE, -(STAKE + STAKE)],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    it('reverts BadDemand once a checkpoint exists', async () => {
      const ctx = await liveTable()
      // openDispute checkpoints; then a setup dispute is no longer valid.
      const state = mkState(ctx.tableId)
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
      // resolve back to Live with a newer state so we can attempt disputeSetup
      const newer = mkState(ctx.tableId, { nonce: 2n })
      const cs = await cosign(ctx, newer)
      await ctx.zk.write.respondWithState([ctx.tableId, newer, cs.sigA, cs.sigB], { account: ctx.b.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.disputeSetup([ctx.tableId], { account: ctx.a.account }),
        'BadDemand',
      )
    })
  })

  describe('openDispute', () => {
    it('stores the state, marks Disputed, and emits DisputeOpened', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId)
      const { sigA, sigB } = await cosign(ctx, state)
      const blockNo = await ctx.publicClient.getBlockNumber()
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.openDispute(
          [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_SHARE, 7],
          { account: ctx.a.account },
        ),
        ctx.zk,
        'DisputeOpened',
        { tableId: ctx.tableId, disputant: 1, demandKind: DEMAND_SHARE, demandSlot: 7, deadline: blockNo + 1n + CLOCK },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Disputed)
      expect(table[DISPUTANT]).to.equal(1)
      expect(table[DEMAND_KIND]).to.equal(DEMAND_SHARE)
    })

    it('reverts BadGameState when the gameState does not match the hash', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId, { gameStateHash: viem.keccak256(viem.toHex('different')) })
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: ctx.a.account },
        ),
        'BadGameState',
      )
    })

    it('reverts NotYourTurn when the counterparty owes nothing', async () => {
      const ctx = await liveTable()
      // turnMask = my own seat (A=bit0=1) only; counterparty B (bit1) owes nothing.
      await ctx.rules.write.setTurnMask([1])
      const state = mkState(ctx.tableId)
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: ctx.a.account },
        ),
        'NotYourTurn',
      )
    })

    it('reverts ConservationViolated for a non-conserving state', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId, { pot: viem.parseEther('0.4') }) // sums to 1.9, not 2
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: ctx.a.account },
        ),
        'ConservationViolated',
      )
    })

    it('reverts StaleNonce against an existing checkpoint', async () => {
      const ctx = await liveTable()
      // checkpoint at nonce 5 via openDispute then respondWithState (nonce 6) back to Live
      const s5 = mkState(ctx.tableId, { nonce: 5n })
      const c5 = await cosign(ctx, s5)
      await ctx.zk.write.openDispute(
        [ctx.tableId, s5, c5.sigA, c5.sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
      const s6 = mkState(ctx.tableId, { nonce: 6n })
      const c6 = await cosign(ctx, s6)
      await ctx.zk.write.respondWithState([ctx.tableId, s6, c6.sigA, c6.sigB], { account: ctx.b.account })
      // now checkpointNonce == 6; opening with nonce 4 is stale
      const s4 = mkState(ctx.tableId, { nonce: 4n })
      const c4 = await cosign(ctx, s4)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, s4, c4.sigA, c4.sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: ctx.a.account },
        ),
        'StaleNonce',
      )
    })

    it('reverts BadDemand for an unknown demand kind', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId)
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, state, sigA, sigB, GAME_STATE, 9, 0],
          { account: ctx.a.account },
        ),
        'BadDemand',
      )
    })
  })

  describe('respondWithState', () => {
    const openMove = async (ctx: Awaited<ReturnType<typeof liveTable>>, nonce = 3n) => {
      const state = mkState(ctx.tableId, { nonce })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
    }

    it('a higher nonce clears the dispute and checkpoints', async () => {
      const ctx = await liveTable()
      await openMove(ctx, 3n)
      const newer = mkState(ctx.tableId, { nonce: 4n })
      const { sigA, sigB } = await cosign(ctx, newer)
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.respondWithState([ctx.tableId, newer, sigA, sigB], { account: ctx.b.account }),
        ctx.zk,
        'DisputeAnsweredWithState',
        { tableId: ctx.tableId, nonce: 4n },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('reverts StaleNonce for an equal nonce', async () => {
      const ctx = await liveTable()
      await openMove(ctx, 3n)
      const same = mkState(ctx.tableId, { nonce: 3n })
      const { sigA, sigB } = await cosign(ctx, same)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithState([ctx.tableId, same, sigA, sigB], { account: ctx.b.account }),
        'StaleNonce',
      )
    })

    it('reverts StaleNonce for a lower nonce', async () => {
      const ctx = await liveTable()
      await openMove(ctx, 3n)
      const lower = mkState(ctx.tableId, { nonce: 2n })
      const { sigA, sigB } = await cosign(ctx, lower)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithState([ctx.tableId, lower, sigA, sigB], { account: ctx.b.account }),
        'StaleNonce',
      )
    })

    it('the disputant themself may submit a newer co-signed state', async () => {
      const ctx = await liveTable()
      await openMove(ctx, 3n) // disputant is A
      const newer = mkState(ctx.tableId, { nonce: 4n })
      const { sigA, sigB } = await cosign(ctx, newer)
      // A (the disputant) responds — allowed: any party may submit newer states
      await ctx.zk.write.respondWithState([ctx.tableId, newer, sigA, sigB], { account: ctx.a.account })
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })
  })

  describe('respondWithMove', () => {
    const openMove = async (ctx: Awaited<ReturnType<typeof liveTable>>) => {
      const state = mkState(ctx.tableId, { nonce: 3n })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
    }

    it('clears the dispute and emits the new game-state hash', async () => {
      const ctx = await liveTable()
      await openMove(ctx)
      const nextState = viem.toHex('next-game-state')
      await ctx.rules.write.setApply([nextState, false])
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.respondWithMove([ctx.tableId, GAME_STATE, viem.toHex('move')], { account: ctx.b.account }),
        ctx.zk,
        'DisputeAnsweredWithMove',
        { tableId: ctx.tableId, move: viem.toHex('move'), newGameStateHash: viem.keccak256(nextState) },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('bubbles a revert from an illegal move', async () => {
      const ctx = await liveTable()
      await openMove(ctx)
      await ctx.rules.write.setApply([viem.toHex('x'), true]) // applyReverts = true
      let threw = false
      try {
        await ctx.zk.write.respondWithMove([ctx.tableId, GAME_STATE, viem.toHex('move')], { account: ctx.b.account })
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
    })

    it('reverts NotYourDispute when the disputant calls', async () => {
      const ctx = await liveTable()
      await openMove(ctx) // disputant = A
      await ctx.rules.write.setApply([viem.toHex('next'), false])
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithMove([ctx.tableId, GAME_STATE, viem.toHex('move')], { account: ctx.a.account }),
        'NotYourDispute',
      )
    })

    it('reverts NotDemanded when the open demand is not a MOVE', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId, { nonce: 3n })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_SHARE, 0],
        { account: ctx.a.account },
      )
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithMove([ctx.tableId, GAME_STATE, viem.toHex('move')], { account: ctx.b.account }),
        'NotDemanded',
      )
    })
  })

  describe('respondWithShare (mock verifier)', () => {
    const SLOT = 7
    const buildDeck = (slot: number, c1x: bigint, c1y: bigint) => {
      const deck: bigint[] = new Array(208).fill(1n)
      deck[4 * slot] = c1x
      deck[4 * slot + 1] = c1y
      return deck
    }
    const deckCommitment = (deck: bigint[]) =>
      viem.keccak256(viem.encodePacked(deck.map(() => 'uint256'), deck))

    const openShare = async (ctx: Awaited<ReturnType<typeof liveTable>>, commitment: viem.Hex) => {
      const state = mkState(ctx.tableId, { nonce: 3n, deckCommitment: commitment })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_SHARE, SLOT],
        { account: ctx.a.account },
      )
    }

    it('a 208-word deck with matching commitment + mock ok clears and emits', async () => {
      const ctx = await liveTable()
      const deck = buildDeck(SLOT, 11n, 22n)
      const commitment = deckCommitment(deck)
      await openShare(ctx, commitment)
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        ctx.zk,
        'DisputeAnsweredWithShare',
        { tableId: ctx.tableId, slot: SLOT, revealX: 33n, revealY: 44n },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('reverts BadDeck for the wrong deck length', async () => {
      const ctx = await liveTable()
      const deck = buildDeck(SLOT, 11n, 22n)
      const commitment = deckCommitment(deck)
      await openShare(ctx, commitment)
      const short = deck.slice(0, 207)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, short as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'BadDeck',
      )
    })

    it('reverts BadDeck for the wrong commitment', async () => {
      const ctx = await liveTable()
      const deck = buildDeck(SLOT, 11n, 22n)
      await openShare(ctx, viem.keccak256(viem.toHex('not-the-deck')))
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'BadDeck',
      )
    })

    it('reverts BadProof when the mock verifier returns false', async () => {
      const ctx = await liveTable()
      await ctx.verifier.write.setOk([false])
      const deck = buildDeck(SLOT, 11n, 22n)
      const commitment = deckCommitment(deck)
      await openShare(ctx, commitment)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'BadProof',
      )
    })
  })

  describe('respondWithShare (real vendored RevealVerifier)', () => {
    const SLOT = 3
    const pi = revealFixture.pi.map((v) => BigInt(v))
    const zkproof = revealFixture.zkproof.map((v) => BigInt(v)) as unknown as Proof8

    // Real-verifier table: HiLoWarRules pointed at a deployed RevealVerifier; the
    // responding seat (B) registers deckKey = pi[4..5] (pk).
    const realTable = async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const revealAddress = await deployOrEtchRevealVerifier()
      const rules = await hre.viem.deployContract('HiLoWarRules', [revealAddress, viem.zeroAddress])
      // Build a deck whose demanded slot's first two words = pi[0..1].
      const deck: bigint[] = new Array(208).fill(1n)
      deck[4 * SLOT] = pi[0]!
      deck[4 * SLOT + 1] = pi[1]!
      const commitment = viem.keccak256(viem.encodePacked(deck.map(() => 'uint256'), deck))
      // HiLoWarRules.whoseTurn needs a real HiLo encoding; use a DEAL-phase state
      // where both seats owe (mask = 3) so B (counterparty) owes the SHARE.
      const hiloState = viem.encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'phase', type: 'uint8' },
              { name: 'deckIndex', type: 'uint32' },
              { name: 'ante', type: 'uint256' },
              { name: 'pot', type: 'uint256' },
              { name: 'warPot', type: 'uint256' },
              { name: 'contributedA', type: 'uint256' },
              { name: 'contributedB', type: 'uint256' },
              { name: 'commitA', type: 'bytes32' },
              { name: 'commitB', type: 'bytes32' },
              { name: 'betA', type: 'uint8' },
              { name: 'betB', type: 'uint8' },
              { name: 'raiser', type: 'uint8' },
              { name: 'resultWinner', type: 'uint8' },
              { name: 'resultAmount', type: 'uint256' },
              { name: 'resultSet', type: 'bool' },
              { name: 'foldedCardHidden', type: 'bool' },
            ],
          },
        ],
        [
          {
            phase: 1, // PHASE_DEAL → mask 3
            deckIndex: 0,
            ante: 0n,
            pot: 0n,
            warPot: 0n,
            contributedA: 0n,
            contributedB: 0n,
            commitA: viem.zeroHash,
            commitB: viem.zeroHash,
            betA: 0,
            betB: 0,
            raiser: 0,
            resultWinner: 0,
            resultAmount: 0n,
            resultSet: false,
            foldedCardHidden: false,
          },
        ],
      )
      const gameStateHash = viem.keccak256(hiloState)

      // create with HiLoWarRules; A's deckKey arbitrary, B's deckKey = pi[4..5].
      const [a, b] = ctx.signers
      const createHash = await ctx.zk.write.create(
        [rules.address, STAKE, CLOCK, viem.zeroAddress, [1n, 2n] as unknown as [bigint, bigint]],
        { value: STAKE, account: a!.account },
      )
      const createReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: createHash })
      const [created] = viem.parseEventLogs({ logs: createReceipt.logs, abi: ctx.zk.abi, eventName: 'TableCreated' })
      const tableId = created!.args.tableId
      await ctx.zk.write.join(
        [tableId, viem.zeroAddress, [pi[4]!, pi[5]!] as unknown as [bigint, bigint]],
        { value: STAKE, account: b!.account },
      )

      const state = mkState(tableId, { nonce: 3n, deckCommitment: commitment, gameStateHash })
      const sigA = await signState(a!, ctx.domain, state)
      const sigB = await signState(b!, ctx.domain, state)
      // A disputes against B with a SHARE demand on SLOT
      await ctx.zk.write.openDispute(
        [tableId, state, sigA, sigB, hiloState, DEMAND_SHARE, SLOT],
        { account: a!.account },
      )
      return { ...ctx, tableId, a: a!, b: b!, deck, revealAddress }
    }

    it('accepts a real Groth16 reveal proof and clears the dispute', async () => {
      const ctx = await realTable()
      await expectations.emit(
        asCtx(ctx),
        ctx.zk.write.respondWithShare(
          [ctx.tableId, ctx.deck as unknown as bigint[], [pi[2]!, pi[3]!], zkproof],
          { account: ctx.b.account },
        ),
        ctx.zk,
        'DisputeAnsweredWithShare',
        { tableId: ctx.tableId, slot: SLOT, revealX: pi[2]!, revealY: pi[3]! },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Live)
    })

    it('reverts BadProof on a tampered proof', async () => {
      const ctx = await realTable()
      const tampered = [...zkproof]
      tampered[0] = tampered[0]! + 1n
      const tamperedProof = tampered as unknown as Proof8
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, ctx.deck as unknown as bigint[], [pi[2]!, pi[3]!], tamperedProof],
          { account: ctx.b.account },
        ),
        'BadProof',
      )
    })
  })

  describe('resolveTimeout (move/share dispute)', () => {
    const openMove = async (ctx: Awaited<ReturnType<typeof liveTable>>) => {
      const state = mkState(ctx.tableId, { nonce: 3n })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
      return state
    }

    it('reverts ClockNotExpired before the deadline', async () => {
      const ctx = await liveTable()
      await openMove(ctx)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        'ClockNotExpired',
      )
    })

    it('forfeits the pot to the disputant and pays balances (exact deltas)', async () => {
      const ctx = await liveTable()
      const state = await openMove(ctx) // disputant = A, balances 1.2/0.3, pot 0.5
      await helpers.mine(Number(CLOCK) + 1)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        [ctx.a, ctx.b],
        [state.balanceA + state.pot, state.balanceB],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    it('reverts BadStatus on a second resolve', async () => {
      const ctx = await liveTable()
      await openMove(ctx)
      await helpers.mine(Number(CLOCK) + 1)
      await ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        'BadStatus',
      )
    })
  })

  // Symmetric counterparty paths + status/kind error guards. The suite above drives every
  // happy path with A as the disputant; these cover B-as-disputant (the `seat==1 ? 2 : 1`
  // false side and resolveTimeout's `disputant==2` branch), one-sided payouts, and the
  // wrong-status / wrong-kind / wrong-caller reverts on each dispute entrypoint.
  describe('symmetric + error guards', () => {
    const openMoveBy = async (
      ctx: Awaited<ReturnType<typeof liveTable>>,
      disputant: 'a' | 'b',
      over: Partial<ChannelState> = {},
    ) => {
      const state = mkState(ctx.tableId, { nonce: 3n, ...over })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx[disputant].account },
      )
      return state
    }

    // gap 1: B-as-disputant + B collects pot on timeout (seat==1?2:1 false side, disputant==2 branch)
    it('B as disputant collects the pot on timeout (exact deltas), A keeps balanceA', async () => {
      const ctx = await liveTable()
      const state = await openMoveBy(ctx, 'b') // disputant = B, balances 1.2/0.3, pot 0.5
      const table0 = await ctx.zk.read.tables([ctx.tableId])
      expect(table0[DISPUTANT]).to.equal(2)
      await helpers.mine(Number(CLOCK) + 1)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.b.account }),
        [ctx.a, ctx.b],
        [state.balanceA, state.balanceB + state.pot],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    // gap 2: one-sided payout — the final state hands one seat the whole escrow, the other zero.
    // disputant A, balanceB == 0, pot == 0 ⇒ _payout's `toB > 0` false side (no transfer to B).
    it('one-sided timeout payout pays the full escrow to A and nothing to B', async () => {
      const ctx = await liveTable()
      const state = await openMoveBy(ctx, 'a', {
        balanceA: viem.parseEther('2'),
        balanceB: 0n,
        pot: 0n,
      })
      await helpers.mine(Number(CLOCK) + 1)
      await expectations.changeEtherBalances(
        asCtx(ctx),
        ctx.zk.write.resolveTimeout([ctx.tableId], { account: ctx.a.account }),
        [ctx.a, ctx.b, ctx.zk.address],
        [state.balanceA, 0n, -state.balanceA],
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
    })

    // gap 4: disputeSetup on a non-Live (freshly Created) table
    it('disputeSetup reverts BadStatus on a non-Live table', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const tableId = await createTable(ctx) // Created, not yet joined
      const [a] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.disputeSetup([tableId], { account: a!.account }),
        'BadStatus',
      )
    })

    // gap 5: openDispute on a non-Live (Created) table
    it('openDispute reverts BadStatus on a non-Live table', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const tableId = await createTable(ctx)
      const [a, b] = ctx.signers
      const state = mkState(tableId)
      const sigA = await signState(a!, ctx.domain, state)
      const sigB = await signState(b!, ctx.domain, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: a!.account },
        ),
        'BadStatus',
      )
    })

    // gap 6: respondWithState on a Live (non-Disputed) table
    it('respondWithState reverts BadStatus on a non-Disputed table', async () => {
      const ctx = await liveTable()
      const state = mkState(ctx.tableId)
      const { sigA, sigB } = await cosign(ctx, state)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithState([ctx.tableId, state, sigA, sigB], { account: ctx.b.account }),
        'BadStatus',
      )
    })

    // gap 7: respondWithMove on a Live (non-Disputed) table
    it('respondWithMove reverts BadStatus on a non-Disputed table', async () => {
      const ctx = await liveTable()
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithMove([ctx.tableId, GAME_STATE, viem.toHex('move')], { account: ctx.b.account }),
        'BadStatus',
      )
    })

    // gap 8: respondWithShare on a Live (non-Disputed) table
    it('respondWithShare reverts BadStatus on a non-Disputed table', async () => {
      const ctx = await liveTable()
      const deck: bigint[] = new Array(208).fill(1n)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [0n, 0n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'BadStatus',
      )
    })

    // gap 9: respondWithShare when the open demand is a MOVE (wrong kind) → NotDemanded
    it('respondWithShare reverts NotDemanded when the open demand is a MOVE', async () => {
      const ctx = await liveTable()
      await openMoveBy(ctx, 'a')
      const deck: bigint[] = new Array(208).fill(1n)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [0n, 0n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'NotDemanded',
      )
    })

    // gap 10: respondWithShare called BY the disputant → NotYourDispute
    it('respondWithShare reverts NotYourDispute when the disputant calls', async () => {
      const ctx = await liveTable()
      const SLOT = 7
      const deck: bigint[] = new Array(208).fill(1n)
      deck[4 * SLOT] = 11n
      deck[4 * SLOT + 1] = 22n
      const commitment = viem.keccak256(viem.encodePacked(deck.map(() => 'uint256'), deck))
      const state = mkState(ctx.tableId, { nonce: 3n, deckCommitment: commitment })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_SHARE, SLOT],
        { account: ctx.a.account }, // disputant = A
      )
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.a.account }, // A is the disputant — cannot answer their own demand
        ),
        'NotYourDispute',
      )
    })

    // gap 11: respondWithShare with demandSlot > 51 → BadDeck on the slot check
    it('respondWithShare reverts BadDeck when demandSlot exceeds 51', async () => {
      const ctx = await liveTable()
      const SLOT = 52
      // A 208-word deck with a matching commitment so the length + commitment checks pass and the
      // slot > 51 guard is the one that fires. deck[4*52..] would be out of range, but the slot
      // check happens before any deck[4*slot] access.
      const deck: bigint[] = new Array(208).fill(1n)
      const commitment = viem.keccak256(viem.encodePacked(deck.map(() => 'uint256'), deck))
      const state = mkState(ctx.tableId, { nonce: 3n, deckCommitment: commitment })
      const { sigA, sigB } = await cosign(ctx, state)
      await ctx.zk.write.openDispute(
        [ctx.tableId, state, sigA, sigB, GAME_STATE, DEMAND_SHARE, SLOT],
        { account: ctx.a.account },
      )
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithShare(
          [ctx.tableId, deck as unknown as bigint[], [33n, 44n], ZERO_PROOF],
          { account: ctx.b.account },
        ),
        'BadDeck',
      )
    })

    // gap 12: respondWithMove with a gameState that doesn't hash to disputeState.gameStateHash
    it('respondWithMove reverts BadGameState when the gameState mismatches the contested hash', async () => {
      const ctx = await liveTable()
      await openMoveBy(ctx, 'a') // contested gameStateHash = keccak256(GAME_STATE)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.respondWithMove(
          [ctx.tableId, viem.toHex('a-different-game-state'), viem.toHex('move')],
          { account: ctx.b.account },
        ),
        'BadGameState',
      )
    })

    // gap 13: settle with a stale nonce AFTER a checkpoint exists (hasCheckpoint && nonce <= checkpointNonce)
    it('settle reverts StaleNonce once a checkpoint exists and the final nonce is not newer', async () => {
      const ctx = await liveTable()
      // Establish checkpointNonce = 5 via openDispute(5) then respondWithState(6) back to Live.
      const s5 = mkState(ctx.tableId, { nonce: 5n })
      const c5 = await cosign(ctx, s5)
      await ctx.zk.write.openDispute(
        [ctx.tableId, s5, c5.sigA, c5.sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
      const s6 = mkState(ctx.tableId, { nonce: 6n })
      const c6 = await cosign(ctx, s6)
      await ctx.zk.write.respondWithState([ctx.tableId, s6, c6.sigA, c6.sigB], { account: ctx.b.account })
      // Now checkpointNonce == 6. A final co-signed state at nonce 5 (<= checkpoint) is stale.
      const final = mkState(ctx.tableId, {
        nonce: 5n,
        balanceA: viem.parseEther('2'),
        balanceB: 0n,
        pot: 0n,
        phase: 1,
      })
      const cf = await cosign(ctx, final)
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.settle([ctx.tableId, final, cf.sigA, cf.sigB], { account: ctx.a.account }),
        'StaleNonce',
      )
    })
  })

  describe('conservation across top-up', () => {
    it('reverts ConservationViolated for a pre-top-up state, accepts a post-top-up one', async () => {
      const ctx = await liveTable()
      const pre = mkState(ctx.tableId, { nonce: 3n }) // sums to 2 ETH
      const preSigs = await cosign(ctx, pre)
      const amount = viem.parseEther('0.5')
      await ctx.zk.write.topUp([ctx.tableId], { value: amount, account: ctx.a.account })
      await expectations.revertedWithCustomError(
        ctx.zk,
        ctx.zk.write.openDispute(
          [ctx.tableId, pre, preSigs.sigA, preSigs.sigB, GAME_STATE, DEMAND_MOVE, 0],
          { account: ctx.a.account },
        ),
        'ConservationViolated',
      )
      // fresh post-top-up state summing to 2.5 ETH is accepted
      const post = mkState(ctx.tableId, {
        nonce: 4n,
        balanceA: viem.parseEther('1.7'),
        balanceB: viem.parseEther('0.3'),
        pot: viem.parseEther('0.5'),
      })
      const postSigs = await cosign(ctx, post)
      await ctx.zk.write.openDispute(
        [ctx.tableId, post, postSigs.sigA, postSigs.sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: ctx.a.account },
      )
      const table = await ctx.zk.read.tables([ctx.tableId])
      expect(table[STATUS]).to.equal(Status.Disputed)
    })
  })

  // CEI / no-double-payout invariant on the money path. A malicious contract player re-enters
  // ZkTable.resolveTimeout from its receive() when the forced payout lands. ZkTable flips status to
  // Settled and zeroes escrow BEFORE transferring (checks-effects-interactions), so the reentrant
  // call hits BadStatus and is swallowed by forceSafeTransferETH's gas stipend — the outer tx still
  // settles and the attacker is paid exactly once.
  describe('reentrancy (CEI / no double payout)', () => {
    it('a reentrant resolveTimeout on payout is neutralized — single payout, table Settled', async () => {
      const ctx = await helpers.loadFixture(deployZk)
      const [a, b] = ctx.signers
      // attacker contract is the wallet seat A; signer A is its channel-signing key.
      const attacker = await hre.viem.deployContract('ReenteringReceiver', [ctx.zk.address])

      // create via the attacker so playerA == attacker (payout target), channelKey == a (signer).
      await attacker.write.createTable(
        [ctx.rules.address, STAKE, CLOCK, a!.account.address, DECK_KEY_A as unknown as [bigint, bigint]],
        { value: STAKE, account: a!.account },
      )
      const tableId = (await attacker.read.table()) as viem.Hex
      await joinTable(ctx, tableId)

      // A (the disputant, via its channel key) opens a MOVE dispute; B never answers.
      const state = mkState(tableId, { nonce: 3n })
      const sigA = await signState(a!, ctx.domain, state)
      const sigB = await signState(b!, ctx.domain, state)
      await ctx.zk.write.openDispute(
        [tableId, state, sigA, sigB, GAME_STATE, DEMAND_MOVE, 0],
        { account: a!.account },
      )
      await helpers.mine(Number(CLOCK) + 1)

      // arm the re-entry, then resolve. Expected payout to the attacker: balanceA + pot (it is the
      // disputant seat A); B gets balanceB.
      await attacker.write.arm([true])
      const before = await ctx.publicClient.getBalance({ address: attacker.address })
      await ctx.zk.write.resolveTimeout([tableId], { account: b!.account })
      const after = await ctx.publicClient.getBalance({ address: attacker.address })

      // outer tx settled the table exactly once
      const table = await ctx.zk.read.tables([tableId])
      expect(table[STATUS]).to.equal(Status.Settled)
      // attacker re-entered once and that inner call reverted (BadStatus), changing no money
      expect(await attacker.read.reentryCalls()).to.equal(1n)
      expect(await attacker.read.lastReentryReverted()).to.equal(true)
      // paid exactly once: net delta == balanceA + pot, not double
      expect(after - before).to.equal(state.balanceA + state.pot)
      expect(await attacker.read.received()).to.equal(state.balanceA + state.pot)
    })
  })
})
