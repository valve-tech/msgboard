import { describe, it, expect, vi } from 'vitest'
import { keccak256, hexToString, stringToHex, type Hex } from 'viem'
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
  postedTableIds,
  decodeVerifiedFeed,
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

      // ── the round-transcript really landed on the public board (confirmed by tableId presence) ──
      const posted = postedTableIds(feedMsgs)
      expect(posted.has(result.tableId.toLowerCase())).toBe(true)
    } finally {
      house.stop()
    }
  }, 25_000)

  it('fires the commit/reveal milestones when their board posts land — not before (accurate handshake timing)', async () => {
    // The handshake timeline shows, per step, "elapsed when this step landed". The two PLAYER milestones
    // are board POSTS: `commit` = the sealed open-request, `reveal` = the seed-revealing round-request.
    // Each must be timestamped when its post actually reaches the board — not at the instant we intend to
    // send — else `commit` reads 0.0s (fired before any send) and `reveal` reads the grant time (fired
    // before houseDriver posts the round-request). We assert the milestones follow their real sends,
    // recorded off the board.
    const inner = fakeBoard()
    const timeline: string[] = []
    const recording: BoardClient = {
      content: inner.content,
      addMessage: async (msg: { category: Hex; data: Hex }) => {
        let kind = 'other'
        try { kind = (JSON.parse(hexToString(msg.data)) as { kind?: string }).kind ?? 'other' } catch { /* not a JSON envelope */ }
        timeline.push(`send:${kind}`)
        return inner.addMessage(msg)
      },
    }
    const house = startLandingHouse(recording)
    try {
      await runBoardFlip({
        board: recording, chainId: CHAIN_ID, pick: 'heads', playerKey: PLAYER_KEY,
        onStep: (s) => timeline.push(`step:${s}`), pollMs: 2, timeoutMs: 15_000,
      })
      // `commit` lands only after the open-request is actually on the board.
      const iOpenReq = timeline.indexOf('send:open-request')
      const iCommit = timeline.indexOf('step:commit')
      expect(iOpenReq).toBeGreaterThanOrEqual(0)
      expect(iCommit).toBeGreaterThan(iOpenReq)
      // `reveal` lands only after the seed-revealing round-request is posted.
      const iRoundReq = timeline.indexOf('send:round-request')
      const iReveal = timeline.indexOf('step:reveal')
      expect(iRoundReq).toBeGreaterThanOrEqual(0)
      expect(iReveal).toBeGreaterThan(iRoundReq)
    } finally {
      house.stop()
    }
  }, 25_000)

  it('derives the shown seed/side from the VERIFIED proof, not the house-posted transcript string', async () => {
    // A board that lets the house co-sign honestly (so the proof the player verifies is correct) but
    // TAMPERS the serverSeed inside the round-transcript JSON the house posts back. If the UI derived its
    // display from that transcript string (the old bug), result.serverSeed would be the garbage value and
    // would NOT hash to rngCommit. With the fix, the seed comes from the co-signed proof and still checks.
    const GARBAGE = ('0x' + 'ee'.repeat(32)) as Hex
    const inner = fakeBoard()
    const tampering: BoardClient = {
      content: inner.content,
      addMessage: async (msg: { category: Hex; data: Hex }) => {
        try {
          const wire = JSON.parse(hexToString(msg.data)) as { kind?: string; transcriptJson?: string }
          if (wire.kind === 'round-transcript' && typeof wire.transcriptJson === 'string') {
            const t = JSON.parse(wire.transcriptJson) as { entries: Array<{ kind: string; body: Record<string, unknown> }> }
            for (const e of t.entries) if (e.kind === 'ROUND') e.body.serverSeed = GARBAGE
            wire.transcriptJson = JSON.stringify(t)
            return inner.addMessage({ category: msg.category, data: stringToHex(JSON.stringify(wire)) })
          }
        } catch { /* not a transcript envelope — pass through untouched */ }
        return inner.addMessage(msg)
      },
    }
    const house = startLandingHouse(tampering)
    try {
      const result = await runBoardFlip({
        board: tampering, chainId: CHAIN_ID, pick: 'heads', playerKey: PLAYER_KEY, pollMs: 2, timeoutMs: 15_000,
      })
      // The shown serverSeed came from the verified proof: it still reveal-checks against rngCommit…
      expect(result.serverSeed).not.toBe(GARBAGE)
      expect(result.commitOk).toBe(true)
      expect(commitSeed(result.serverSeed)).toBe(result.rngCommit)
      // …and the shown side/win remain internally consistent with that verified seed.
      expect(result.side).toBe(coinFlipSide(result.raw))
      expect(result.win).toBe(result.side === result.pick)
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

describe('house-address pin (VITE_LANDING_HOUSE_ADDRESS): counterparty identity + verified public feed', () => {
  const WRONG_HOUSE = ('0x' + 'ab'.repeat(20)) as Hex

  it('accepts the real house address at open and rejects a wrong pinned house', async () => {
    const board = fakeBoard()
    const house = startLandingHouse(board)
    try {
      // Correct pin → the OpenTerms signature recovers to the real house → the round completes.
      const ok = await runBoardFlip({
        board, chainId: CHAIN_ID, pick: 'heads', playerKey: PLAYER_KEY,
        houseAddress: house.houseAddress, pollMs: 2, timeoutMs: 15_000,
      })
      expect(ok.commitOk).toBe(true)
      // Wrong pin → the real house's OpenTerms sig doesn't match → abort before revealing the seed.
      await expect(runBoardFlip({
        board, chainId: CHAIN_ID, pick: 'heads', playerKey: PLAYER_KEY,
        houseAddress: WRONG_HOUSE, pollMs: 2, timeoutMs: 15_000,
      })).rejects.toThrow(/not signed by the expected landing house/)
    } finally {
      house.stop()
    }
  }, 25_000)

  it('decodeVerifiedFeed surfaces house-verified rounds and rejects transcripts not signed by the pinned house', async () => {
    const board = fakeBoard()
    const house = startLandingHouse(board)
    try {
      const res = await runBoardFlip({
        board, chainId: CHAIN_ID, pick: 'heads', playerKey: PLAYER_KEY,
        houseAddress: house.houseAddress, pollMs: 2, timeoutMs: 15_000,
      })
      const msgs = (await board.content({}))[landingCategoryHash(CHAIN_ID)] ?? []
      // Pinned to the REAL house → the round re-verifies off the board and appears.
      const feed = await decodeVerifiedFeed(msgs, { houseAddress: house.houseAddress, chainId: CHAIN_ID })
      expect(feed.length).toBe(1)
      expect(feed[0]).toMatchObject({ side: res.side, win: res.win, tableId: res.tableId })
      // Pinned to a DIFFERENT address → the same board data verifies to nothing (no forgeable feed).
      const wrong = await decodeVerifiedFeed(msgs, { houseAddress: WRONG_HOUSE, chainId: CHAIN_ID })
      expect(wrong.length).toBe(0)
    } finally {
      house.stop()
    }
  }, 25_000)
})
