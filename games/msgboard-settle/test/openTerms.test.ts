import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { makeSettleDomain, signOpenTerms, verifyOpenTermsSig, type OpenTerms } from '../src/openTerms'

const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const channel = '0x00000000000000000000000000000000000c4a11' as Hex

const terms: OpenTerms = {
  tableId: `0x${'ab'.repeat(32)}`,
  player: player.address,
  playerKey: player.address,
  escrowPlayer: 200n,
  escrowHouse: 200n,
  gameId: 1,
  rngCommit: `0x${'cd'.repeat(32)}`,
  clockBlocks: 30n,
  expiry: 9_999_999_999n,
  clientSeedCommit: `0x${'ef'.repeat(32)}`,
  paramsHash: `0x${'12'.repeat(32)}`,
}

describe('OpenTerms signing', () => {
  it('round-trips a house signature and rejects the wrong signer', async () => {
    const domain = makeSettleDomain(31337, channel)
    const sig = await signOpenTerms(house, domain, terms)
    expect(await verifyOpenTermsSig(house.address, domain, terms, sig)).toBe(true)
    expect(await verifyOpenTermsSig(player.address, domain, terms, sig)).toBe(false)
  })
})
