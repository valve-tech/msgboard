/**
 * Tests for handleOpenRequest, coSignRound, startHouse, and faucetMint.
 *
 * Security invariants tested:
 *  1. House builds seed chain BLIND: env.terms.rngCommit === env.seedChain.commit (house-built,
 *     NOT taken from req) — req only carries clientSeedCommit, never a plaintext seed.
 *  2. Round step: a mismatched revealed clientSeed is rejected BEFORE runHouseSide is called.
 *  3. End-to-end: runPlayerSide + coSignRound over a memoryCoSignPair produces a transcript
 *     that verifyFinishedSession accepts, and terms.rngCommit verifyReveal-matches the
 *     serverSeed in the ROUND entry.
 *  4. faucetMint caps to min(amount, cap), rejects negative amounts, and calls writeContract correctly.
 */
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { makeSettleDomain } from '@msgboard/settle'
import {
  commitSeed, buildSeedChain, verifyReveal,
  runPlayerSide, verifyFinishedSession,
  dice,
} from '@msgboard/games'
import type { Hex } from 'viem'
import type { CoSignTransport } from '@msgboard/games'
import type { VerifyContext } from '@msgboard/games'
import type { DiceParams } from '@msgboard/games'
import { TEST_DOMAIN } from '@msgboard/games'
import { handleOpenRequest, coSignRound, startHouse } from '../src/houseLoop'
import type { HouseDeps } from '../src/houseLoop'
import { faucetMint } from '../src/faucet'

// ── fixtures ─────────────────────────────────────────────────────────────────

const HOUSE_KEY_HEX = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const PLAYER_KEY_HEX = ('0x' + '11'.repeat(32)) as Hex

const HOUSE_ACCOUNT = privateKeyToAccount(HOUSE_KEY_HEX)
const PLAYER_ACCOUNT = privateKeyToAccount(PLAYER_KEY_HEX)

// Thin adapters matching StateSigner + EnvelopeSigner
const houseKey = {
  address: HOUSE_ACCOUNT.address,
  signTypedData: (a: Parameters<typeof HOUSE_ACCOUNT.signTypedData>[0]) => HOUSE_ACCOUNT.signTypedData(a),
  signMessage: (a: Parameters<typeof HOUSE_ACCOUNT.signMessage>[0]) => HOUSE_ACCOUNT.signMessage(a),
} as const

const playerSigner = {
  address: PLAYER_ACCOUNT.address,
  signTypedData: (a: Parameters<typeof PLAYER_ACCOUNT.signTypedData>[0]) => PLAYER_ACCOUNT.signTypedData(a),
  signMessage: (a: Parameters<typeof PLAYER_ACCOUNT.signMessage>[0]) => PLAYER_ACCOUNT.signMessage(a),
} as const

const domain = makeSettleDomain(943, '0x57876609E4fEDDEeB83e46A1b3A20140998f0e46')
const limits = {
  maxEscrowHouse: 10n ** 24n,
  clockBlocks: 120n,
  expiryBlocks: 300n,
}

const clientSeed = ('0x' + 'aa'.repeat(32)) as Hex
const clientSeedCommit = commitSeed(clientSeed) // keccak256(clientSeed)
const tableId = ('0x' + 'ab'.repeat(32)) as Hex

const baseReq = {
  tableId,
  player: '0x000000000000000000000000000000000000dEaD' as Hex,
  playerKey: PLAYER_ACCOUNT.address,
  gameId: dice.gameId,
  // Raw game params (the board codec transports the bigint); reviewOpen routes these to dice.
  params: { targetX100: 5000n },
  stake: 1_000n,
  // SECURITY: only the commit is sent; plaintext seed stays with the player
  clientSeedCommit,
}

// Injected deterministic tip for test repeatability (prod uses randomBytes)
const deterministicTip = ('0x' + '77'.repeat(32)) as Hex

// In-memory CoSignTransport pair (mirrors msgboard-games/test/helpers.ts memoryCoSignPair)
function memoryCoSignPair(): { houseT: CoSignTransport; playerT: CoSignTransport } {
  type Pending = {
    state: unknown
    proof?: unknown
    resolve: (sig: Hex) => void
    reject: (err: unknown) => void
  }
  const queue: Pending[] = []
  const waiters: Array<(p: Pending) => void> = []

  const push = (p: Pending) => {
    const w = waiters.shift()
    if (w) w(p)
    else queue.push(p)
  }
  const pull = (): Promise<Pending> =>
    new Promise((res) => {
      const q = queue.shift()
      if (q) res(q)
      else waiters.push(res)
    })

  const houseT: CoSignTransport = {
    request: (state, proof) => new Promise<Hex>((resolve, reject) => push({ state, proof, resolve, reject })),
    serve: () => { throw new Error('houseT.serve is not used') },
  }

  const playerT: CoSignTransport = {
    request: () => { throw new Error('playerT.request is not used') },
    serve: (sign) => {
      const loop = async () => {
        for (;;) {
          const p = await pull()
          try {
            p.resolve(await sign(p.state as any, p.proof as any))
          } catch (err) {
            p.reject(err)
          }
        }
      }
      void loop()
    },
  }

  return { houseT, playerT }
}

// ── handleOpenRequest tests ───────────────────────────────────────────────────

describe('handleOpenRequest', () => {
  it('answers a valid open-request with a signed grant whose rngCommit is the house chain head', async () => {
    const env = await handleOpenRequest(baseReq, {
      houseKey,
      domain,
      headBlock: 1000n,
      limits,
      game: dice,
      seedTip: deterministicTip,
    })

    expect(env.kind).toBe('open-grant')
    if (env.kind !== 'open-grant') return

    // Correct escrow
    expect(env.terms.escrowHouse).toBe(980n)

    // SECURITY REQUIREMENT 1: rngCommit is the house-built seed chain commit, not from req
    expect(env.terms.rngCommit).toBe(env.seedChain.commit)

    // The commit should equal the chain built from the injected tip
    const expectedChain = buildSeedChain(deterministicTip, 1)
    expect(env.terms.rngCommit).toBe(expectedChain.commit)

    // houseSig should be a valid hex signature
    expect(env.houseSig).toMatch(/^0x/)
    expect(env.houseSig.length).toBe(132) // 65-byte ECDSA sig
  })

  it('declines params the routed game rejects (maxMultiplierX100 throws → invalid params)', async () => {
    // 99999n is outside dice's valid target range [1, 9899], so dice.maxMultiplierX100 throws and
    // reviewOpen surfaces it as a decline instead of crashing.
    const env = await handleOpenRequest(
      { ...baseReq, params: { targetX100: 99_999n } },
      { houseKey, domain, headBlock: 1000n, limits, game: dice, seedTip: deterministicTip },
    )
    expect(env.kind).toBe('open-decline')
    if (env.kind === 'open-decline') expect(env.reason).toMatch(/invalid params/i)
  })

  it('builds rngCommit from ctx seedTip, not from the request (BLIND tip)', async () => {
    // The OpenRequest type has no clientSeed field — only clientSeedCommit. Verify the
    // rngCommit in the grant is derived from the injected ctx.seedTip and NOT from any
    // request field: even if we pass a different tip the result changes accordingly.
    const otherTip = ('0x' + 'ff'.repeat(32)) as Hex
    const envA = await handleOpenRequest(baseReq, { houseKey, domain, headBlock: 1000n, limits, game: dice, seedTip: deterministicTip })
    const envB = await handleOpenRequest(baseReq, { houseKey, domain, headBlock: 1000n, limits, game: dice, seedTip: otherTip })

    // Both must be grants with distinct rngCommit (tip-driven, not req-driven)
    expect(envA.kind).toBe('open-grant')
    expect(envB.kind).toBe('open-grant')
    if (envA.kind !== 'open-grant' || envB.kind !== 'open-grant') return
    expect(envA.terms.rngCommit).not.toBe(envB.terms.rngCommit)
    // Each must match the corresponding chain
    expect(envA.terms.rngCommit).toBe(buildSeedChain(deterministicTip, 1).commit)
    expect(envB.terms.rngCommit).toBe(buildSeedChain(otherTip, 1).commit)
  })
})

// ── coSignRound tests (replaces handleRoundRequest tests) ────────────────────

describe('coSignRound — end-to-end co-sign', () => {
  /**
   * END-TO-END TEST: runs runPlayerSide and the house flow (handleOpenRequest → coSignRound)
   * concurrently over a memoryCoSignPair, then asserts:
   *  (a) verifyFinishedSession returns true — the full transcript is cryptographically valid,
   *  (b) terms.rngCommit verifyReveal-matches the serverSeed in the ROUND entry — the commitment
   *      made at open time is genuinely the seed revealed in the round.
   * This proves a real co-signed transcript was produced, NOT a test that's green by absence.
   */
  it('produces a verifyFinishedSession-valid transcript (genuine co-sign, not green-by-absence)', async () => {
    const { houseT, playerT } = memoryCoSignPair()
    const tip = deterministicTip

    // Open step (house side)
    const grantEnv = await handleOpenRequest(baseReq, {
      houseKey,
      domain,
      headBlock: 1000n,
      limits,
      game: dice,
      seedTip: tip,
    })
    expect(grantEnv.kind).toBe('open-grant')
    if (grantEnv.kind !== 'open-grant') return

    const openBalances = { player: 1000n, house: 1000n }
    const settlementMode = 0

    const sessionCfg = {
      domain: TEST_DOMAIN,
      tableId,
      game: dice,
      player: playerSigner,
      house: houseKey,
      seedTip: tip,
      chainLength: 1 as const,
      openBalances,
      settlementMode,
    }

    const verifyCtx: VerifyContext<DiceParams> = {
      parties: { player: PLAYER_ACCOUNT.address, house: HOUSE_ACCOUNT.address },
      commit: buildSeedChain(tip, 1).commit,
      game: dice,
      domain: TEST_DOMAIN,
    }

    const playerCfg = {
      domain: TEST_DOMAIN,
      tableId,
      game: dice,
      player: playerSigner,
      houseRemote: true as const,
      clientSeed,
      seedTip: tip,
      chainLength: 1 as const,
      openBalances,
      settlementMode,
    }

    // Run house co-sign and player side concurrently
    const [coSignResult] = await Promise.all([
      coSignRound(
        { clientSeed, stake: 100n, params: { targetX100: 5000n } },
        {
          clientSeedCommit,
          seedChain: grantEnv.seedChain,
          sessionCfg,
          transport: houseT,
        },
      ),
      runPlayerSide(playerCfg, playerT),
    ])

    // (a) The round must succeed
    expect(coSignResult.ok).toBe(true)
    if (!coSignResult.ok) return

    // (a) Full session verification
    expect(await verifyFinishedSession(coSignResult.transcriptJson, verifyCtx)).toBe(true)

    // (b) terms.rngCommit must verifyReveal-match the serverSeed in the ROUND entry
    const transcript = JSON.parse(coSignResult.transcriptJson)
    const roundEntry = transcript.entries.find((e: { kind: string }) => e.kind === 'ROUND')
    expect(roundEntry).toBeDefined()
    const serverSeedInTranscript: Hex = roundEntry.body.serverSeed
    expect(verifyReveal(grantEnv.terms.rngCommit, serverSeedInTranscript)).toBe(true)
  })

  it('refuses (ok: false) when revealed clientSeed does not match the commit — no transcript produced', async () => {
    const { houseT } = memoryCoSignPair()
    const grantEnv = await handleOpenRequest(baseReq, {
      houseKey,
      domain,
      headBlock: 1000n,
      limits,
      game: dice,
      seedTip: deterministicTip,
    })
    if (grantEnv.kind !== 'open-grant') throw new Error('expected grant')

    const wrongSeed = ('0x' + 'ff'.repeat(32)) as Hex

    // runHouseSide is NEVER called — the verify gate fires first.
    // No player-side needed; if runHouseSide were called it would hang waiting for the player.
    const result = await coSignRound(
      { clientSeed: wrongSeed, stake: 100n, params: { targetX100: 5000n } },
      {
        clientSeedCommit,
        seedChain: grantEnv.seedChain,
        sessionCfg: {
          domain: TEST_DOMAIN, tableId, game: dice,
          player: playerSigner, house: houseKey,
          seedTip: deterministicTip, chainLength: 1,
          openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
        },
        transport: houseT,
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/clientSeed/i)
    }
  })
})

// ── startHouse integration test ───────────────────────────────────────────────

describe('startHouse — injected in-memory deps, full table flow', () => {
  it('drives one full table (open → round) and posts a round-transcript', async () => {
    const { houseT, playerT } = memoryCoSignPair()
    const posted: unknown[] = []
    const tip = deterministicTip
    const stake = 100n
    const params = { targetX100: 5000n }
    // The player must co-sign the SAME nonce-0 floor the house derives from the signed escrow.
    // startHouse now sizes escrow per-table from the open-request: escrowFor(stake=100, mult=198) =
    // { player: 100, house: (100*(198-100))/100 = 98 }. Both sides open with exactly that.
    const openBalances = { player: 100n, house: 98n }

    // Prepare the player side to respond concurrently
    const playerCfg = {
      domain: TEST_DOMAIN,
      tableId,
      game: dice,
      player: playerSigner,
      houseRemote: true as const,
      clientSeed,
      seedTip: tip,
      chainLength: 1 as const,
      openBalances,
      settlementMode: 0,
    }

    // Message feed: we push two messages (open-request, then round-request after grant posted)
    // We use a custom async iterable that yields messages as the house processes them.
    const grantPostedResolve: { resolve?: () => void } = {}
    const grantPostedPromise = new Promise<void>((r) => { grantPostedResolve.resolve = r })

    async function* messagesFeed(): AsyncGenerator<unknown> {
      // First: open-request
      yield {
        kind: 'open-request',
        tableId,
        player: '0x000000000000000000000000000000000000dEaD' as Hex,
        playerKey: PLAYER_ACCOUNT.address,
        gameId: dice.gameId,
        params: { targetX100: 5000n },
        stake,
        clientSeedCommit,
      }
      // Wait until the grant is posted so we know the house state is ready
      await grantPostedPromise
      // Second: round-request
      yield {
        kind: 'round-request',
        tableId,
        clientSeed,
        stake: stake.toString(),
        params,
        playerAddress: '0x000000000000000000000000000000000000dEaD' as Hex,
        playerKey: PLAYER_ACCOUNT.address,
      }
    }

    const deps: HouseDeps = {
      messages: messagesFeed(),
      postMessage: async (msg) => {
        posted.push(msg)
        const m = msg as Record<string, unknown>
        if (m['kind'] === 'open-grant') {
          grantPostedResolve.resolve?.()
        }
      },
      makeTransport: (_tableId) => ({ houseT, playerT }),
      getHeadBlock: async () => 1000n,
    }

    const houseCfg = {
      boardRpc: 'http://localhost:8545',
      chainId: 31337,
      houseChannel: ('0x' + '00'.repeat(32)) as Hex,
      houseKey,
      limits,
      domain: TEST_DOMAIN,
      games: [dice],
      settlementMode: 0,
      // Inject deterministic tip so verifyCtx.commit is predictable
      seedTip: tip,
    }

    const { stop } = startHouse(houseCfg, deps)

    // Run the player side concurrently
    await Promise.all([
      // Wait for the transcript to be posted
      new Promise<void>((resolve) => {
        const checkPosted = setInterval(() => {
          const transcript = posted.find((m) => (m as Record<string, unknown>)['kind'] === 'round-transcript')
          if (transcript) {
            clearInterval(checkPosted)
            resolve()
          }
        }, 10)
      }),
      runPlayerSide(playerCfg, playerT),
    ])

    stop()

    // Assert the round-transcript was posted
    const transcriptMsg = posted.find((m) => (m as Record<string, unknown>)['kind'] === 'round-transcript') as
      Record<string, unknown> | undefined
    expect(transcriptMsg).toBeDefined()
    expect(typeof transcriptMsg?.['transcriptJson']).toBe('string')

    // Verify the transcript is cryptographically valid
    const verifyCtx: VerifyContext<DiceParams> = {
      parties: { player: PLAYER_ACCOUNT.address, house: HOUSE_ACCOUNT.address },
      commit: buildSeedChain(tip, 1).commit,
      game: dice,
      domain: TEST_DOMAIN,
    }
    expect(await verifyFinishedSession(transcriptMsg?.['transcriptJson'] as string, verifyCtx)).toBe(true)
  })
})

// ── faucetMint tests ──────────────────────────────────────────────────────────

describe('faucetMint', () => {
  const chips = ('0x' + 'cc'.repeat(20)) as Hex
  const to = ('0x' + 'dd'.repeat(20)) as Hex
  const cap = 1_000n

  it('calls writeContract with min(amount, cap) when amount <= cap', async () => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue('0xabcd' as Hex) } as any
    const txHash = await faucetMint({ walletClient, chips, to, amount: 500n, cap })
    expect(txHash).toBe('0xabcd')
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    const call = walletClient.writeContract.mock.calls[0][0]
    // Should mint exactly `amount` (500 < 1000 cap)
    expect(call.args[1]).toBe(500n)
    expect(call.args[0]).toBe(to)
  })

  it('calls writeContract with cap when amount > cap', async () => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue('0xbeef' as Hex) } as any
    const txHash = await faucetMint({ walletClient, chips, to, amount: 5_000n, cap })
    expect(txHash).toBe('0xbeef')
    const call = walletClient.writeContract.mock.calls[0][0]
    // Should mint only up to cap
    expect(call.args[1]).toBe(cap)
  })

  it('calls writeContract targeting the chips contract address', async () => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue('0xcafe' as Hex) } as any
    await faucetMint({ walletClient, chips, to, amount: 100n, cap })
    const call = walletClient.writeContract.mock.calls[0][0]
    expect(call.address).toBe(chips)
  })

  it('rejects negative amount before calling writeContract', async () => {
    const walletClient = { writeContract: vi.fn() } as any
    await expect(faucetMint({ walletClient, chips, to, amount: -1n, cap })).rejects.toThrow(/negative/)
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })
})
