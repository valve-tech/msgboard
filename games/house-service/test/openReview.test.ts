import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { dice } from '@msgboard/games'
import { makeSettleDomain, verifyOpenTermsSig } from '@msgboard/settle'
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
})
