import { describe, it, expect, vi } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  coinflip,
  coinFlipSide,
  makeDomain,
  commitSeed,
  runPlayerSide,
  type BoardClient,
  type CoSignTransport,
  type SessionState,
  type RoundProof,
  type Signer,
  type CoinFlipParams,
} from '@msgboard/games'
import { landingHouseCategory } from '@msgboard/settle'
import { startHouse, makeBoardHouseDeps } from '@msgboard/games-house-service'
import {
  runBoardFlip,
  decodeFeed,
  landingCategoryHash,
  FUN_STAKE,
  LANDING_HOUSE_CHANNEL,
} from '../src/lib/arcade-engine'

/**
 * Arcade coin-flip tests.
 *
 * The block-hash `flipOutcome` math is GONE — that scheme was NOT provably fair (the player could grind
 * an editable client seed against a public block hash). These tests drive the REAL board-mediated
 * commit-reveal round the landing now plays:
 *   1. `runBoardFlip` against an in-memory board + the REAL landing house (`startHouse`) — proving the
 *      full split-key handshake reaches a co-signed outcome, publishes to the board (mandatory), and
 *      moves the play-money balance by the co-signed delta.
 *   2. the player-side fairness check is LIVE: a tampered house seed (commit mismatch) is REJECTED by
 *      `runPlayerSide`/`verifyProposedState` before the player will co-sign.
 */

const CHAIN_ID = 943
const HOUSE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const PLAYER_KEY = ('0x' + '11'.repeat(32)) as Hex
const TIP = ('0x' + '99'.repeat(32)) as Hex

/** Shared in-memory BoardClient: one append-only log per category (the MsgBoard storage model). */
function fakeBoard(): BoardClient {
  const store: Record<string, Array<{ data: Hex }>> = {}
  return {
    addMessage: async ({ category, data }: { category: Hex; data: Hex }) => {
      ;(store[category] ??= []).push({ data })
      return {}
    },
    content: async ({ category }: { category?: Hex }) =>
      category ? { [category]: store[category] ?? [] } : store,
  }
}

/** Stand up the real landing house (coinflip-only, optimistic, isolated category) on `board`. */
function startLandingHouse(board: BoardClient) {
  const houseAccount = privateKeyToAccount(HOUSE_KEY)
  const houseKey: Signer = {
    address: houseAccount.address,
    signTypedData: (a) => houseAccount.signTypedData(a as Parameters<typeof houseAccount.signTypedData>[0]),
    signMessage: (a) => houseAccount.signMessage(a as Parameters<typeof houseAccount.signMessage>[0]),
  }
  const { deps, stop: stopDeps } = makeBoardHouseDeps({
    board,
    chainId: CHAIN_ID,
    getHeadBlock: async () => 1000n,
    pollMs: 2,
    timeoutMs: 15_000,
    category: landingHouseCategory(CHAIN_ID),
  })
  const houseCtl = startHouse(
    {
      boardRpc: 'mem://board',
      chainId: CHAIN_ID,
      houseChannel: LANDING_HOUSE_CHANNEL,
      houseKey,
      limits: { maxEscrowHouse: 10n ** 24n, clockBlocks: 120n, expiryBlocks: 300n },
      domain: makeDomain(CHAIN_ID, LANDING_HOUSE_CHANNEL),
      games: [coinflip],
      settlementMode: 0,
      seedTip: TIP,
    },
    deps,
  )
  return { stop: () => { houseCtl.stop(); stopDeps() }, houseAddress: houseAccount.address }
}

describe('runBoardFlip — real board-mediated commit-reveal round vs the house bot', () => {
  it('reaches a co-signed outcome, publishes to the board, and moves play-money by the co-signed delta', async () => {
    const board = fakeBoard()
    const house = startLandingHouse(board)
    const onStep = vi.fn()
    try {
      const result = await runBoardFlip({
        board,
        chainId: CHAIN_ID,
        pick: 'heads',
        playerKey: PLAYER_KEY,
        onStep,
        pollMs: 2,
        timeoutMs: 15_000,
      })

      // ── the outcome is the parity of the ACTUAL co-signed seeds (never fabricated) ──
      expect(result.side).toBe(coinFlipSide(result.raw))
      expect(result.win).toBe(result.side === result.pick)

      // ── the commit-reveal check the player enforced holds on the revealed transcript ──
      expect(result.commitOk).toBe(true)
      expect(commitSeed(result.serverSeed)).toBe(result.rngCommit)

      // ── play-money moves by the co-signed delta: win → +stake (2×), lose → −stake ──
      expect(result.stake).toBe(FUN_STAKE)
      expect(result.playerDelta).toBe(result.win ? FUN_STAKE : -FUN_STAKE)
      const balanceAfter = 1000n + result.playerDelta
      expect(balanceAfter).toBe(result.win ? 1100n : 900n)

      // ── mandatory publishing: the whole handshake really posted to the isolated board feed ──
      const store = await board.content({})
      const feedMsgs = store[landingCategoryHash(CHAIN_ID)] ?? []
      expect(feedMsgs.length).toBeGreaterThan(0)

      // ── the handshake showcase saw every milestone, in order ──
      expect(onStep.mock.calls.map((c) => c[0])).toEqual(['commit', 'grant', 'reveal', 'transcript'])

      // ── the feed reads the round-transcript BACK off the board and recomputes it ──
      const feed = decodeFeed(feedMsgs)
      expect(feed.length).toBe(1)
      expect(feed[0]).toMatchObject({ win: result.win, side: result.side, tableId: result.tableId })
    } finally {
      house.stop()
    }
  }, 25_000)
})

// ── A minimal co-sign transport the TEST drives as a (malicious) house: it captures the player's
//    registered sign fn so we can hand it a tampered state and observe the rejection. ──
function captureTransport(): {
  transport: CoSignTransport
  request: (s: SessionState, proof?: RoundProof<CoinFlipParams>) => Promise<Hex>
} {
  let signFn: ((s: SessionState, proof?: RoundProof<unknown>) => Promise<Hex>) | undefined
  const transport: CoSignTransport = {
    request: () => Promise.reject(new Error('unused: player side does not request')),
    serve: (sign) => { signFn = sign },
    serveClose: () => {},
    requestClose: () => Promise.resolve('0x' as Hex),
  }
  return {
    transport,
    request: (s, proof) => {
      if (!signFn) throw new Error('player has not registered its sign fn yet')
      return signFn(s, proof as RoundProof<unknown> | undefined)
    },
  }
}

describe('player-side fairness check is live', () => {
  it('REJECTS a tampered house seed (revealed serverSeed does not hash to the committed rngCommit)', async () => {
    const domain = makeDomain(CHAIN_ID, LANDING_HOUSE_CHANNEL)
    const tableId = ('0x' + 'ab'.repeat(32)) as Hex
    const clientSeed = ('0x' + 'cd'.repeat(32)) as Hex
    const playerAccount = privateKeyToAccount(PLAYER_KEY)
    const player: Signer = {
      address: playerAccount.address,
      signTypedData: (a) => playerAccount.signTypedData(a as Parameters<typeof playerAccount.signTypedData>[0]),
      signMessage: (a) => playerAccount.signMessage(a as Parameters<typeof playerAccount.signMessage>[0]),
    }
    const openBalances = { player: FUN_STAKE, house: FUN_STAKE }

    // The house commits to seedA but later reveals seedB — keccak256(seedB) != rngCommit.
    const honestSeed = ('0x' + '01'.repeat(32)) as Hex
    const tamperedSeed = ('0x' + '02'.repeat(32)) as Hex
    const rngCommit = keccak256(honestSeed)
    expect(keccak256(tamperedSeed)).not.toBe(rngCommit)

    const { transport, request } = captureTransport()
    const rejection = runPlayerSide(
      {
        domain,
        tableId,
        game: coinflip,
        player,
        houseRemote: true as const,
        clientSeed,
        seedTip: ('0x' + '00'.repeat(32)) as Hex,
        chainLength: 1,
        openBalances,
        settlementMode: 0,
      },
      transport,
    )
    // Swallow the eventual runPlayerSide rejection (asserted via the round request below).
    rejection.catch(() => {})

    // A valid OPEN (nonce 0) — the player accepts and records rngCommit.
    const openState: SessionState = {
      tableId,
      nonce: 0n,
      balancePlayer: openBalances.player,
      balanceHouse: openBalances.house,
      settlementMode: 0,
      gameId: coinflip.gameId,
      gameStateHash: ('0x' + '00'.repeat(32)) as Hex,
      rngCommit,
    }
    await expect(request(openState)).resolves.toMatch(/^0x[0-9a-f]+$/i)

    // A tampered ROUND (nonce 1): correct clientSeed, but serverSeed does NOT reveal to rngCommit.
    const params: CoinFlipParams = { pick: 'heads' }
    const roundState: SessionState = {
      ...openState,
      nonce: 1n,
      balancePlayer: openBalances.player + FUN_STAKE, // a bogus "you won" state
      balanceHouse: openBalances.house - FUN_STAKE,
    }
    const proof: RoundProof<CoinFlipParams> = {
      serverSeed: tamperedSeed,
      clientSeed,
      stake: FUN_STAKE,
      params,
    }
    await expect(request(roundState, proof)).rejects.toThrow(/bad seed reveal/)
  })
})
