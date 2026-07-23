import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { buildHeatLocations } from '../src/operator'

const A = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as viem.Hex
const B = '0xBbbBBbbbBbbBbbbBbBBBBBBBBbbbBbBbBbbBbbBb' as viem.Hex
const C = '0xCccCCcccCccCcccCcCCCCCCCCcccCcCcCccCccCc' as viem.Hex

describe('buildHeatLocations', () => {
  it('produces one location per subset member, in subset order, providers bound positionally', () => {
    const locations = buildHeatLocations([A, B, C], {})
    expect(locations).to.have.length(3)
    expect(locations.map((l) => l.provider)).to.deep.equal([A, B, C])
  })

  it('applies per-provider pool offsets case-insensitively and defaults missing ones to zero', () => {
    const locations = buildHeatLocations([A, B], { [A.toLowerCase()]: 7n })
    expect(locations[0]!.offset).to.equal(7n)
    expect(locations[1]!.offset).to.equal(0n)
  })

  it('pins the canonical heat settings the games expect (price 0, native token, 12 blocks)', () => {
    const [location] = buildHeatLocations([A], {})
    expect(location!.price).to.equal(0n)
    expect(location!.token).to.equal(viem.zeroAddress)
    expect(location!.duration).to.equal(12n)
    expect(location!.durationIsTimestamp).to.equal(false)
    expect(location!.callAtChange).to.equal(false)
    expect(location!.index).to.equal(0n)
  })
})
