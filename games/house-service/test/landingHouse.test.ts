/**
 * landingHouse.test.ts — the landing coin-flip house bot, driven end to end over an in-memory board.
 *
 * The house here is assembled from `landingHouseConfig(...)` — the EXACT config object the deployable
 * entrypoint (`scripts/run-landing-house.ts` → `runLandingHouse`) passes to `runBoardHouse`. We source
 * `games`, `category`, `settlementMode`, `limits`, and the domain `verifyingContract` straight from
 * that config and feed them to the same `makeBoardHouseDeps` + `startHouse` units `runBoardHouse` wires
 * (the only piece we substitute is the board transport — an in-memory log instead of a live RPC, so the
 * round runs without network). A player using `makeBoardPlayerSession` on the SAME landing category
 * plays one flip; we then prove:
 *
 *   1. the co-signed transcript verifies (`verifyFinishedSession`),
 *   2. the coin-flip outcome recomputes from the REVEALED seeds (roundRandom → parity → face),
 *   3. it routed via gameId 5 (coinflip),
 *   4. it ran on the landing category and left the default arcade category untouched, and
 *   5. the optimistic path (settlementMode 0) carries NO on-chain settlement expectation.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import {
  commitSeed, makeDomain, coinflip, coinFlipSide, roundRandom, Transcript,
  runPlayerSide, verifyFinishedSession, MsgBoardTransport,
  type BoardClient, type VerifyContext, type CoinFlipParams,
} from '@msgboard/games'
import { makeBoardPlayerSession, houseCategory, landingHouseCategory } from '@msgboard/settle'
import { startHouse, makeBoardHouseDeps, landingHouseConfig } from '../src/index'
import { DEPLOYMENT_943 } from '../src/liveConfig'

/** Shared in-memory BoardClient: one append-only log per category, over the real MsgBoardTransport path. */
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

describe('landing coin-flip house — landingHouseConfig driven end to end', () => {
  it('produces the expected zero-stakes, coinflip-only, optimistic, isolated-category run config', () => {
    const cfg = landingHouseConfig({ houseSigner: houseKey })
    // coinflip-only (gameId 5), optimistic (no on-chain settle), isolated landing category.
    expect(cfg.games).toEqual([coinflip])
    expect(cfg.games?.[0]?.gameId).toBe(5)
    expect(cfg.settlementMode).toBe(0)
    expect(cfg.category).toEqual(landingHouseCategory(cfg.chainId))
    // Signs-only key; EIP-712 domain anchored to the deployed 943 HouseChannel (never called).
    expect(cfg.houseSigner.address).toBe(houseAccount.address)
    expect(cfg.houseChannel).toBe(DEPLOYMENT_943.houseChannel)
    expect(cfg.chainId).toBe(DEPLOYMENT_943.chainId)
  })

  it('plays one flip: transcript verifies, outcome recomputes from seeds, routes gameId 5, on the landing category', async () => {
    const board = fakeBoard()
    const cfg = landingHouseConfig({ houseSigner: houseKey, chainId: 943, pollMs: 2, timeoutMs: 15_000 })
    const chainId = cfg.chainId

    // The domain both sides sign under, anchored to the config's houseChannel (never called on-chain).
    const domain = makeDomain(chainId, cfg.houseChannel)
    const tip = ('0x' + '99'.repeat(32)) as Hex
    const clientSeed = ('0x' + 'ee'.repeat(32)) as Hex
    const tableId = ('0x' + 'ef'.repeat(32)) as Hex
    const stake = 100n // play-money fun-chips; nothing settles on-chain in optimistic mode.
    const params: CoinFlipParams = { pick: 'heads' }

    // Category-isolation fixtures.
    const landingHash = new MsgBoardTransport(board, cfg.category!).category
    const defaultHash = new MsgBoardTransport(board, houseCategory(chainId)).category
    expect(landingHash).not.toBe(defaultHash)

    // ── house: assembled from the landing run-config (games/category/settlementMode/limits from cfg) ──
    const { deps, stop: stopDeps } = makeBoardHouseDeps({
      board, chainId, getHeadBlock: async () => 1000n,
      pollMs: cfg.pollMs, timeoutMs: cfg.timeoutMs, category: cfg.category,
    })
    const houseCtl = startHouse(
      {
        boardRpc: 'mem://board', chainId, houseChannel: cfg.houseChannel, houseKey: cfg.houseSigner,
        limits: cfg.limits, domain, games: cfg.games!, settlementMode: cfg.settlementMode, seedTip: tip,
      },
      deps,
    )

    // ── player: same landing category ──
    const accepted: Array<{ nonce: bigint }> = []
    const session = makeBoardPlayerSession({
      board, chainId, tableId, pollMs: 2, timeoutMs: 15_000,
      category: landingHouseCategory(chainId),
      onAccept: (s) => accepted.push(s as { nonce: bigint }),
    })

    const { terms, houseSig } = await session.requestOpen({
      tableId, player: playerAccount.address, playerKey: playerAccount.address,
      gameId: coinflip.gameId, params, stake, clientSeedCommit: commitSeed(clientSeed),
    })
    // routed via gameId 5, sized by the fair 2× ceiling.
    expect(terms.gameId).toBe(5)
    expect(terms.escrowHouse).toBe(100n) // stake*(200-100)/100 = stake
    expect(houseSig).toMatch(/^0x[0-9a-f]{130}$/i)

    const openBalances = { player: terms.escrowPlayer, house: terms.escrowHouse }
    runPlayerSide(
      {
        domain, tableId, game: coinflip, player: playerSigner, houseRemote: true as const,
        clientSeed, seedTip: ('0x' + '00'.repeat(32)) as Hex, chainLength: 1 as const,
        openBalances, settlementMode: 0,
      },
      session.playerT,
    ).catch(() => { /* a refusal would surface as a houseDriver timeout below */ })
    const stopServing = session.startServing()

    const transcriptJson = await session.houseDriver<CoinFlipParams>({
      stake, params, clientSeed, playerAddress: playerAccount.address,
    })

    // 1. the co-signed transcript is cryptographically whole.
    const ctx: VerifyContext<CoinFlipParams> = {
      parties: { player: playerAccount.address, house: houseAccount.address },
      commit: terms.rngCommit, game: coinflip, domain,
    }
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
    expect(accepted.map((s) => s.nonce)).toEqual([0n, 1n])

    // 2. the outcome recomputes from the REVEALED seeds: raw = roundRandom(serverSeed, clientSeed, round);
    //    parity → face; the game's own settleRound reproduces the recorded win/delta.
    const round = Transcript.fromJSON(transcriptJson).entries.find((e) => e.kind === 'ROUND')
    expect(round).toBeDefined()
    const rb = round!.body as {
      round: number; stake: string; clientSeed: Hex; serverSeed: Hex
      outcome: { win: boolean; playerDelta: string; multiplierX100: string }
    }
    expect(rb.clientSeed).toBe(clientSeed) // player's revealed seed is the one it committed to.
    const raw = roundRandom(rb.serverSeed, rb.clientSeed, BigInt(rb.round))
    const side = coinFlipSide(raw)
    const recomputed = coinflip.settleRound(BigInt(rb.stake), params, raw)
    expect(recomputed.win).toBe(side === params.pick)
    expect(recomputed.win).toBe(rb.outcome.win)
    expect(recomputed.playerDelta.toString()).toBe(rb.outcome.playerDelta)
    expect(recomputed.multiplierX100.toString()).toBe(rb.outcome.multiplierX100)
    // a fair 2× coin: win pays exactly 2.00×, lose pays 0.
    expect(rb.outcome.multiplierX100).toBe(recomputed.win ? '200' : '0')

    // 4. isolation: all traffic is on the landing category; the default arcade category is untouched.
    const store = await board.content({})
    expect((store[landingHash] ?? []).length).toBeGreaterThan(0)
    expect(store[defaultHash]).toBeUndefined()

    // 5. optimistic (settlementMode 0) → no on-chain settlement expectation. The OPEN state records
    //    optimistic mode; conservation holds off-chain and nothing is ever handed to a HouseChannel.
    expect(cfg.settlementMode).toBe(0)
    const open = Transcript.fromJSON(transcriptJson).entries.find((e) => e.kind === 'OPEN')
    expect((open!.body as { settlementMode?: number }).settlementMode).toBe(0)

    stopServing()
    houseCtl.stop()
    stopDeps()
  }, 25_000)
})
