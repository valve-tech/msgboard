/**
 * boardE2E.test.ts — the guard against the "in-memory shortcut" the reviews kept catching.
 *
 * This wires the REAL production house (`startHouse` + `makeBoardHouseDeps`) to the REAL production
 * player session (`makeBoardPlayerSession` + `runPlayerSide`) over a SHARED in-memory board that
 * exercises the actual MsgBoardTransport JSON encode/decode path. Nothing here is a stub: the only
 * fake is the board's storage backend (an append-only log), exactly as a real MsgBoard would serve.
 *
 * It proves the full split-key protocol end to end:
 *   1. player posts an open-request (clientSeedCommit only) → house grants signed OpenTerms
 *      (NO seed chain on the wire) sized to the player's escrow,
 *   2. player reveals clientSeed in a round-request → house verifies the reveal, drives OPEN+ROUND
 *      co-signing over the board, posts back the finished transcript,
 *   3. the transcript passes `verifyFinishedSession`, and `EscrowedSettlement.buildSettle` accepts it
 *      and yields a nonce-1 settle call — i.e. the exact bytes the HouseChannel contract would pay.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import {
  commitSeed, buildSeedChain, makeDomain, dice, limbo,
  runPlayerSide, verifyFinishedSession,
  type BoardClient, type VerifyContext, type DiceParams, type LimboParams,
} from '@msgboard/games'
import { makeBoardPlayerSession, EscrowedSettlement } from '@msgboard/settle'
import { startHouse, makeBoardHouseDeps } from '../src/index'

/** Shared in-memory BoardClient: one append-only log per category. Both sides see each other's
 *  messages through the real MsgBoardTransport JSON path. */
function fakeBoard(): BoardClient {
  const store: Record<string, Array<{ data: Hex }>> = {}
  return {
    addMessage: async ({ category, data }: { category: Hex; data: Hex }) => { (store[category] ??= []).push({ data }); return {} },
    content: async ({ category }: { category?: Hex }) => (category ? { [category]: store[category] ?? [] } : store),
  }
}

const HOUSE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const PLAYER_KEY = ('0x' + '11'.repeat(32)) as Hex
const houseAccount = privateKeyToAccount(HOUSE_KEY)
const playerAccount = privateKeyToAccount(PLAYER_KEY)

const houseKey = {
  address: houseAccount.address,
  signTypedData: (a: Parameters<typeof houseAccount.signTypedData>[0]) => houseAccount.signTypedData(a),
  signMessage: (a: Parameters<typeof houseAccount.signMessage>[0]) => houseAccount.signMessage(a),
} as const
const playerSigner = {
  address: playerAccount.address,
  signTypedData: (a: Parameters<typeof playerAccount.signTypedData>[0]) => playerAccount.signTypedData(a),
  signMessage: (a: Parameters<typeof playerAccount.signMessage>[0]) => playerAccount.signMessage(a),
} as const

describe('board E2E — real startHouse ↔ real board player session', () => {
  it('opens, co-signs one round over the board, and produces a settle-able nonce-1 transcript', async () => {
    const board = fakeBoard()
    const chainId = 943
    const channel = ('0x' + '00'.repeat(20)) as Hex
    const domain = makeDomain(chainId, channel)
    const tip = ('0x' + '77'.repeat(32)) as Hex
    const clientSeed = ('0x' + 'aa'.repeat(32)) as Hex
    const tableId = ('0x' + 'ab'.repeat(32)) as Hex
    const stake = 100n
    const params: DiceParams = { targetX100: 5000n }

    // ── house ──────────────────────────────────────────────────────────────────
    const { deps, stop: stopDeps } = makeBoardHouseDeps({
      board, chainId, getHeadBlock: async () => 1000n, pollMs: 2, timeoutMs: 15_000,
    })
    const houseCtl = startHouse(
      {
        boardRpc: 'mem://board', chainId, houseChannel: channel, houseKey,
        limits: { maxEscrowHouse: 10n ** 24n, clockBlocks: 120n, expiryBlocks: 300n },
        domain, games: [dice, limbo], settlementMode: 1, seedTip: tip,
      },
      deps,
    )

    // ── player ─────────────────────────────────────────────────────────────────
    // onAccept fires after the player co-signs each state (OPEN then ROUND); the web hook uses it to
    // derive the on-screen receipt from the state both parties signed.
    const accepted: Array<{ nonce: bigint }> = []
    const session = makeBoardPlayerSession({
      board, chainId, tableId, pollMs: 2, timeoutMs: 15_000,
      onAccept: (s) => accepted.push(s as { nonce: bigint }),
    })

    // 1. open handshake: post clientSeedCommit only, receive house-signed OpenTerms.
    const { terms, houseSig } = await session.requestOpen({
      tableId, player: playerAccount.address, playerKey: playerAccount.address,
      gameId: dice.gameId, params, stake, clientSeedCommit: commitSeed(clientSeed),
    })

    // The grant is sized from the player's odds (escrowFor(100, 198) = {100, 98}) and its rngCommit
    // is the house's blind seed-chain head — never a value the player supplied.
    expect(terms.escrowPlayer).toBe(100n)
    expect(terms.escrowHouse).toBe(98n)
    expect(terms.rngCommit).toBe(buildSeedChain(tip, 1).commit)
    expect(houseSig).toMatch(/^0x[0-9a-f]{130}$/i)

    // 2. start serving co-sign requests, then drive the round (reveals clientSeed).
    const openBalances = { player: terms.escrowPlayer, house: terms.escrowHouse }
    runPlayerSide(
      {
        domain, tableId, game: dice, player: playerSigner, houseRemote: true as const,
        clientSeed, seedTip: ('0x' + '00'.repeat(32)) as Hex, chainLength: 1 as const,
        openBalances, settlementMode: 1,
      },
      session.playerT,
    ).catch(() => { /* a refusal would surface as a houseDriver timeout below */ })
    const stopServing = session.startServing()

    const transcriptJson = await session.houseDriver<DiceParams>({
      stake, params, clientSeed, playerAddress: playerAccount.address,
    })

    // 3a. the transcript is cryptographically whole (chain links, both co-sigs, seed reveal, outcome).
    const ctx: VerifyContext<DiceParams> = {
      parties: { player: playerAccount.address, house: houseAccount.address },
      commit: terms.rngCommit, game: dice, domain,
    }
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)

    // 3b. EscrowedSettlement accepts it and produces the on-chain settle call for the FINAL state.
    const esc = new EscrowedSettlement<DiceParams>({
      parties: { player: playerAccount.address, house: houseAccount.address },
      commit: terms.rngCommit, game: dice, domain, settlementMode: 1, channel,
    })
    const settleTx = await esc.buildSettle(transcriptJson)
    expect(settleTx.functionName).toBe('settle')
    const finalState = settleTx.args[0] as { nonce: bigint; balancePlayer: bigint; balanceHouse: bigint }
    expect(finalState.nonce).toBe(1n) // one roll per table → final state is nonce 1
    // conservation: the round only moves chips between the two parties; the pot is constant.
    expect(finalState.balancePlayer + finalState.balanceHouse).toBe(terms.escrowPlayer + terms.escrowHouse)

    // onAccept observed the player co-signing both the OPEN (nonce 0) and ROUND (nonce 1) states —
    // the capture path the web receipt relies on.
    expect(accepted.map((s) => s.nonce)).toEqual([0n, 1n])

    stopServing()
    houseCtl.stop()
    stopDeps()
  }, 25_000)

  it('routes a LIMBO round (gameId 2) end to end over the SAME shared board — multi-game routing', async () => {
    // Same end-to-end flow as the dice case, but for limbo (gameId 2). The shared startHouse registry
    // is [dice, limbo]: it must size escrow with limbo.maxMultiplierX100 at OPEN and co-sign the ROUND
    // with limbo (NOT dice) — proving the table settles under the game it opened with (funds safety).
    const board = fakeBoard()
    const chainId = 943
    const channel = ('0x' + '00'.repeat(20)) as Hex
    const domain = makeDomain(chainId, channel)
    const tip = ('0x' + '88'.repeat(32)) as Hex
    const clientSeed = ('0x' + 'bb'.repeat(32)) as Hex
    const tableId = ('0x' + 'cd'.repeat(32)) as Hex
    const stake = 100n
    const params: LimboParams = { targetX100: 200n } // 2.00x target

    const { deps, stop: stopDeps } = makeBoardHouseDeps({
      board, chainId, getHeadBlock: async () => 1000n, pollMs: 2, timeoutMs: 15_000,
    })
    const houseCtl = startHouse(
      {
        boardRpc: 'mem://board', chainId, houseChannel: channel, houseKey,
        limits: { maxEscrowHouse: 10n ** 24n, clockBlocks: 120n, expiryBlocks: 300n },
        domain, games: [dice, limbo], settlementMode: 1, seedTip: tip,
      },
      deps,
    )

    const accepted: Array<{ nonce: bigint }> = []
    const session = makeBoardPlayerSession({
      board, chainId, tableId, pollMs: 2, timeoutMs: 15_000,
      onAccept: (s) => accepted.push(s as { nonce: bigint }),
    })

    // OPEN: escrow sized by limbo.maxMultiplierX100({targetX100:200}) = 200 → escrowFor(100, 200).
    const { terms, houseSig } = await session.requestOpen({
      tableId, player: playerAccount.address, playerKey: playerAccount.address,
      gameId: limbo.gameId, params, stake, clientSeedCommit: commitSeed(clientSeed),
    })
    expect(terms.gameId).toBe(limbo.gameId)
    expect(terms.escrowPlayer).toBe(100n)
    expect(terms.escrowHouse).toBe(100n) // stake*(200-100)/100 = stake
    expect(terms.rngCommit).toBe(buildSeedChain(tip, 1).commit)
    expect(houseSig).toMatch(/^0x[0-9a-f]{130}$/i)

    const openBalances = { player: terms.escrowPlayer, house: terms.escrowHouse }
    runPlayerSide(
      {
        domain, tableId, game: limbo, player: playerSigner, houseRemote: true as const,
        clientSeed, seedTip: ('0x' + '00'.repeat(32)) as Hex, chainLength: 1 as const,
        openBalances, settlementMode: 1,
      },
      session.playerT,
    ).catch(() => { /* a refusal would surface as a houseDriver timeout below */ })
    const stopServing = session.startServing()

    const transcriptJson = await session.houseDriver<LimboParams>({
      stake, params, clientSeed, playerAddress: playerAccount.address,
    })

    // The transcript co-signed under LIMBO is cryptographically whole.
    const ctx: VerifyContext<LimboParams> = {
      parties: { player: playerAccount.address, house: houseAccount.address },
      commit: terms.rngCommit, game: limbo, domain,
    }
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)

    // EscrowedSettlement (under limbo) yields the nonce-1 final state — the bytes the contract pays.
    const esc = new EscrowedSettlement<LimboParams>({
      parties: { player: playerAccount.address, house: houseAccount.address },
      commit: terms.rngCommit, game: limbo, domain, settlementMode: 1, channel,
    })
    const settleTx = await esc.buildSettle(transcriptJson)
    expect(settleTx.functionName).toBe('settle')
    const finalState = settleTx.args[0] as { nonce: bigint; balancePlayer: bigint; balanceHouse: bigint }
    expect(finalState.nonce).toBe(1n)
    expect(finalState.balancePlayer + finalState.balanceHouse).toBe(terms.escrowPlayer + terms.escrowHouse)
    expect(accepted.map((s) => s.nonce)).toEqual([0n, 1n])

    stopServing()
    houseCtl.stop()
    stopDeps()
  }, 25_000)
})
