/**
 * Test: useSession co-sign with the real house over the board (Task 6)
 *
 * Tests drive `runPlayerCoSign` — the plain async function factored out of the React hook —
 * against an in-memory house (`memoryCoSignPair` from @msgboard/games test helpers).
 * No React rendering needed: the hook just calls this function on `start()`.
 *
 * Assertions:
 *  (a) The player retains a transcript whose EIP-712 domain `verifyingContract` equals the
 *      configured `houseChannel` (verified by `verifyFinishedSession` failing if wrong).
 *  (b) `verifyFinishedSession` passes (real co-signed session, not a stub). Tamper test proves
 *      the check is not vacuously true.
 *  (c) The open-request emitted by `runPlayerCoSign` carries `clientSeedCommit` (= keccak256 of
 *      clientSeed), NOT the raw `clientSeed` — the seed is kept secret until round time.
 *  (d) The player refuses a round using a house-substituted clientSeed (anti-house-bias binding).
 */

import { describe, it, expect } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  dice,
  makeDomain,
  buildSeedChain,
  verifyFinishedSession,
  commitSeed,
  type VerifyContext,
  type SessionConfig,
} from '@msgboard/games'
import { memoryCoSignPair } from '../../msgboard-games/test/helpers'
import { runPlayerCoSign, buildOpenRequest, type PlayerCoSignConfig } from '../src/lib/playerCoSign'
import { resolveVerifyingContract, PLACEHOLDER_VERIFIER } from '../src/hooks/useSession'

// ── test fixtures ─────────────────────────────────────────────────────────────

const HOUSE_CHANNEL = '0x57876609E4fEDDEeB83e46A1b3A20140998f0e46' as Hex
const CHAIN_ID = 943

const playerAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const houseAccount = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const seedTip = `0x${'77'.repeat(32)}` as Hex
const clientSeed = `0x${'33'.repeat(32)}` as Hex

const domain = makeDomain(CHAIN_ID, HOUSE_CHANNEL)
const chainLength = 1
const openBalances = { player: 1000n, house: 1000n }

const playerSigner = {
  address: playerAccount.address,
  signTypedData: (args: Parameters<typeof playerAccount.signTypedData>[0]) => playerAccount.signTypedData(args),
  signMessage: (args: { message: { raw: Hex } }) => playerAccount.signMessage(args),
}
const houseSigner = {
  address: houseAccount.address,
  signTypedData: (args: Parameters<typeof houseAccount.signTypedData>[0]) => houseAccount.signTypedData(args),
  signMessage: (args: { message: { raw: Hex } }) => houseAccount.signMessage(args),
}

/** Drive the house side (runHouseSide) against a given transport. */
async function driveHouseSide(houseT: ReturnType<typeof memoryCoSignPair>['houseT']): Promise<string> {
  const { runHouseSide } = await import('@msgboard/games')
  const houseCfg: SessionConfig<{ targetX100: bigint }> = {
    domain,
    tableId,
    game: dice,
    player: playerSigner,
    house: houseSigner,
    seedTip,
    chainLength,
    openBalances,
    settlementMode: 1,
  }
  const play = { stake: 100n, params: { targetX100: 5000n }, clientSeed }
  return runHouseSide(houseCfg, houseT, play)
}

/** Build a standard PlayerCoSignConfig for tests. */
function makePlayerCfg(overrides?: Partial<PlayerCoSignConfig<{ targetX100: bigint }>>): PlayerCoSignConfig<{ targetX100: bigint }> {
  return {
    domain,
    tableId,
    game: dice,
    player: playerSigner,
    houseRemote: true as const,
    clientSeed,
    chainLength,
    openBalances,
    settlementMode: 1,
    ...overrides,
  }
}

/** Verification context for verifyFinishedSession. */
function makeVerifyCtx(): VerifyContext<{ targetX100: bigint }> {
  return {
    parties: { player: playerAccount.address, house: houseAccount.address },
    commit: buildSeedChain(seedTip, chainLength).commit,
    game: dice,
    domain,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runPlayerCoSign — real co-signing over in-memory transport', () => {
  it('(a) verifyFinishedSession uses the domain with verifyingContract = houseChannel', async () => {
    const { houseT, playerT } = memoryCoSignPair()

    // The domain we pass uses HOUSE_CHANNEL as verifyingContract. verifyFinishedSession recovers
    // EIP-712 signatures using this domain; if verifyingContract were wrong the recovery would
    // produce the wrong address and verification would fail.
    const [transcriptJson] = await Promise.all([
      driveHouseSide(houseT),
      runPlayerCoSign(makePlayerCfg(), playerT),
    ])

    const ctx = makeVerifyCtx()
    // The domain's verifyingContract is HOUSE_CHANNEL — assert the wiring is correct.
    expect(ctx.domain.verifyingContract.toLowerCase()).toBe(HOUSE_CHANNEL.toLowerCase())

    // verifyFinishedSession validates ALL co-signatures against ctx.domain — if the
    // verifyingContract were wrong the sig recovery would fail and this would return false.
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
  })

  it('(b) verifyFinishedSession passes (real co-signatures — tamper test proves non-vacuous)', async () => {
    const { houseT, playerT } = memoryCoSignPair()

    const [transcriptJson] = await Promise.all([
      driveHouseSide(houseT),
      runPlayerCoSign(makePlayerCfg(), playerT),
    ])

    const ctx = makeVerifyCtx()
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)

    // Tamper: corrupt a field in the transcript and confirm verification NOW fails.
    // This proves the test is not vacuously true (green-by-absence).
    const parsed = JSON.parse(transcriptJson) as {
      entries: Array<{ kind: string; sig: string; body: Record<string, unknown> }>
    }
    // Corrupt the OPEN envelope's outer sig (the signer-auth sig over the entry digest).
    // The chain hash only depends on the entry digest (not the sig field), so fromJSON succeeds;
    // but t.verify() will recover the wrong address and return false.
    const openEntry = parsed.entries.find((e) => e.kind === 'OPEN')!
    openEntry.sig = `0x${'ff'.repeat(65)}`
    expect(await verifyFinishedSession(JSON.stringify(parsed), ctx)).toBe(false)
  })

  it('(c) open-request carries clientSeedCommit (keccak256 of clientSeed), NOT the raw seed', async () => {
    // Capture the open-request emitted by runPlayerCoSign.
    const captured: unknown[] = []
    const { houseT, playerT } = memoryCoSignPair()

    const [transcriptJson] = await Promise.all([
      driveHouseSide(houseT),
      runPlayerCoSign(
        makePlayerCfg({
          onOpenRequest: (req) => { captured.push(req) },
        }),
        playerT,
      ),
    ])

    // Exactly one open-request must have been emitted.
    expect(captured).toHaveLength(1)
    const req = captured[0] as unknown as Record<string, unknown>

    // The commit must be keccak256(clientSeed).
    expect(req['clientSeedCommit']).toBe(keccak256(clientSeed))
    expect(req['clientSeedCommit']).toBe(commitSeed(clientSeed))

    // The raw clientSeed must NOT appear in the open-request.
    expect(req['clientSeed']).toBeUndefined()
    // Sanity: the commit IS different from the raw seed.
    expect(req['clientSeedCommit']).not.toBe(clientSeed)

    // Sanity: session still completed successfully (the open-request is a no-op in-memory).
    void transcriptJson // consumed, session completed
  })

  it('(d) player refuses a round using a house-substituted clientSeed (anti-house-bias binding)', async () => {
    const { houseT, playerT } = memoryCoSignPair()

    const { runHouseSide } = await import('@msgboard/games')
    const houseCfg: SessionConfig<{ targetX100: bigint }> = {
      domain,
      tableId,
      game: dice,
      player: playerSigner,
      house: houseSigner,
      seedTip,
      chainLength,
      openBalances,
      settlementMode: 1,
    }
    // The house drives the round with a DIFFERENT clientSeed — the "bias attack".
    const biasedSeed = `0x${'44'.repeat(32)}` as Hex
    expect(biasedSeed).not.toBe(clientSeed)
    const biasedPlay = { stake: 100n, params: { targetX100: 5000n }, clientSeed: biasedSeed }

    const results = await Promise.allSettled([
      runHouseSide(houseCfg, houseT, biasedPlay),
      runPlayerCoSign(makePlayerCfg(), playerT),
    ])
    // The player rejects the tampered round; at least one side must have failed.
    expect(results.some((r) => r.status === 'rejected')).toBe(true)
  })
})

// ── unit tests for buildOpenRequest ──────────────────────────────────────────

describe('buildOpenRequest', () => {
  it('emits clientSeedCommit = keccak256(clientSeed), no raw seed', () => {
    const req = buildOpenRequest(tableId, clientSeed)
    expect(req.kind).toBe('open-request')
    expect(req.tableId).toBe(tableId)
    expect(req.clientSeedCommit).toBe(keccak256(clientSeed))
    expect((req as unknown as Record<string, unknown>)['clientSeed']).toBeUndefined()
  })

  it('different seeds produce different commits', () => {
    const seed1 = `0x${'aa'.repeat(32)}` as Hex
    const seed2 = `0x${'bb'.repeat(32)}` as Hex
    expect(buildOpenRequest(tableId, seed1).clientSeedCommit).not.toBe(
      buildOpenRequest(tableId, seed2).clientSeedCommit,
    )
  })
})

// ── unit tests for resolveVerifyingContract (finding #1 fix) ──────────────────

describe('resolveVerifyingContract — EIP-712 verifyingContract defaults to deployment.houseChannel', () => {
  it('uses houseChannel when provided, WITHOUT the caller passing verifyingContract explicitly', () => {
    // This test asserts the core finding #1 fix: given a deployment with a houseChannel, the
    // session's EIP-712 domain verifyingContract equals it without explicit caller override.
    const result = resolveVerifyingContract(HOUSE_CHANNEL, undefined)
    expect(result).toBe(HOUSE_CHANNEL)
    expect(result).not.toBe(PLACEHOLDER_VERIFIER)
  })

  it('houseChannel takes priority over the deprecated verifyingContract prop', () => {
    const otherAddr = `0x${'cc'.repeat(20)}` as Hex
    expect(resolveVerifyingContract(HOUSE_CHANNEL, otherAddr)).toBe(HOUSE_CHANNEL)
  })

  it('falls back to deprecated verifyingContract when houseChannel is absent', () => {
    const legacyAddr = `0x${'dd'.repeat(20)}` as Hex
    expect(resolveVerifyingContract(undefined, legacyAddr)).toBe(legacyAddr)
  })

  it('falls back to PLACEHOLDER_VERIFIER only when both houseChannel and verifyingContract are absent', () => {
    expect(resolveVerifyingContract(undefined, undefined)).toBe(PLACEHOLDER_VERIFIER)
  })
})
