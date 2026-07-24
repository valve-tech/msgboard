import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem'
import { dice, plinko, keno, roulette, RouletteBetType, encodeGameParams } from '@msgboard/games'
import { makeSettleDomain, paramsHashOf, verifyOpenTermsSig } from '@msgboard/settle'
import { reviewOpen } from '../src/openReview'

const HOUSE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const houseKey = { signTypedData: (a: any) => HOUSE.signTypedData(a), signMessage: (a: any) => HOUSE.signMessage(a) } as any
const domain = makeSettleDomain(943, '0x57876609E4fEDDEeB83e46A1b3A20140998f0e46')
const limits = { maxEscrowHouse: 10n ** 24n, clockBlocks: 120n, expiryBlocks: 300n }
// the HOUSE's own seed-chain commit, built blind to the player's clientSeed
const houseRngCommit = ('0x' + '22'.repeat(32)) as `0x${string}`
const baseReq = {
  tableId: ('0x' + '11'.repeat(32)) as `0x${string}`,
  player: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  playerKey: '0x000000000000000000000000000000000000bEEF' as `0x${string}`,
  gameId: dice.gameId, params: { targetX100: 5000n }, stake: 1_000n,
  // the player's entropy COMMITMENT, not the seed — the house never learns clientSeed at open
  clientSeedCommit: ('0x' + '33'.repeat(32)) as `0x${string}`,
}

describe('reviewOpen', () => {
  it('grants in-band terms the player can verify against the house key', async () => {
    const r = await reviewOpen(baseReq, { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: dice })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.terms.escrowPlayer).toBe(1_000n)
    expect(r.terms.escrowHouse).toBe(980n)
    expect(r.terms.gameId).toBe(dice.gameId)
    expect(r.terms.rngCommit).toBe(houseRngCommit) // commit comes from the house, not the request
    expect(await verifyOpenTermsSig(HOUSE.address, domain, r.terms, r.houseSig)).toBe(true)
  })

  it('declines when the escrow ceiling (game-routed) would blow the house cap', async () => {
    // dice target 1n is valid but pays 9900x → escrowHouse = stake*(990000-100)/100 ≫ maxEscrowHouse.
    const r = await reviewOpen({ ...baseReq, params: { targetX100: 1n }, stake: 10n ** 21n }, { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: dice })
    expect(r.ok).toBe(false)
  })

  it('declines params the routed game rejects (maxMultiplierX100 throws)', async () => {
    // 99999n is outside dice's target range → dice.maxMultiplierX100 throws → invalid params decline.
    const r = await reviewOpen({ ...baseReq, params: { targetX100: 99_999n } }, { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: dice })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalid params/i)
  })

  // ── regression: dice's routed paramsHash is byte-identical to the old single-uint256 paramsHashOf ──
  it('keeps dice paramsHash == the legacy single-uint256 hash (no on-chain break)', async () => {
    const r = await reviewOpen(baseReq, { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: dice })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.terms.paramsHash).toBe(paramsHashOf(5000n))
  })

  // ── THE BUG FIX: a non-single-target game (plinko) now OPENS instead of throwing on paramsHash ──
  it('opens a plinko round and binds paramsHash == keccak256(abi.encode(uint256 rows, uint256 riskIdx))', async () => {
    const params = { rows: 16, risk: 'medium' as const }
    const r = await reviewOpen(
      { ...baseReq, gameId: plinko.gameId, params },
      { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: plinko as any },
    )
    expect(r.ok).toBe(true) // before the fix, paramsHashOf(undefined) threw OUTSIDE the try/catch
    if (!r.ok) return
    // the EXACT bytes GamePayouts._plinko decodes: abi.decode(params, (uint256 rows, uint256 riskIdx)),
    // riskIdx 0=low 1=medium 2=high. Rebuild the on-chain-shaped blob independently and compare hashes.
    const onchainParams = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [16n, 1n])
    expect(r.terms.paramsHash).toBe(keccak256(onchainParams))
    // and the encoder's bytes decode back to exactly what _plinko expects
    const [rows, riskIdx] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      encodeGameParams(plinko.gameId, params),
    )
    expect(rows).toBe(16n)
    expect(riskIdx).toBe(1n) // medium
  })

  // ── THE BUG FIX: keno (uint256[] picks) now opens; its blob matches GamePayouts._keno's decode ──
  it('opens a keno round and binds paramsHash == keccak256(abi.encode(uint256[] picks))', async () => {
    const params = { picks: [3, 7, 12, 25] }
    const r = await reviewOpen(
      { ...baseReq, gameId: keno.gameId, params },
      { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: keno as any },
    )
    expect(r.ok).toBe(true) // before the fix, plinko/keno could NEVER open
    if (!r.ok) return
    const onchainParams = encodeAbiParameters([{ type: 'uint256[]' }], [[3n, 7n, 12n, 25n]])
    expect(r.terms.paramsHash).toBe(keccak256(onchainParams))
    const [picks] = decodeAbiParameters([{ type: 'uint256[]' }], encodeGameParams(keno.gameId, params))
    expect(picks).toEqual([3n, 7n, 12n, 25n]) // GamePayouts._keno: abi.decode(params, (uint256[]))
  })

  // ── roulette (tuple[]) reuses the engine's own canonical encoder; prove it decodes as RouletteBet[] ──
  it('opens a roulette round and binds the RouletteBet[] blob GamePayouts._roulette decodes', async () => {
    const params = { bets: [{ type: RouletteBetType.STRAIGHT, selection: 17, stake: 1_000n }] }
    const r = await reviewOpen(
      { ...baseReq, gameId: roulette.gameId, params },
      { houseKey, domain, headBlock: 1000n, limits, rngCommit: houseRngCommit, game: roulette as any },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [bets] = decodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }] }],
      encodeGameParams(roulette.gameId, params),
    ) as unknown as [{ 0: number; 1: number; 2: bigint }[]]
    expect(bets.length).toBe(1)
    expect(Number(bets[0]![0])).toBe(0) // betType STRAIGHT
    expect(Number(bets[0]![1])).toBe(17) // selection
    expect(bets[0]![2]).toBe(1_000n) // stake
    expect(r.terms.paramsHash).toBe(keccak256(encodeGameParams(roulette.gameId, params)))
  })
})
