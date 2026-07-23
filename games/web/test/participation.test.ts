import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { involvement, subsetHashOf } from '../src/model/participation'

const V1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as viem.Hex
const V2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as viem.Hex
const V3 = '0xcccccccccccccccccccccccccccccccccccccccc' as viem.Hex
const PLAYER = '0xdddddddddddddddddddddddddddddddddddddddd' as viem.Hex
const SUBSET = [V1, V2, V3]

describe('involvement', () => {
  it('flags a validator on a canonical-subset game, case-insensitively', () => {
    const game = { mine: false, subsetHash: subsetHashOf(SUBSET) }
    expect(involvement(game, SUBSET, V2.toUpperCase().replace('0X', '0x') as viem.Hex)).to.deep.equal({ played: false, validated: true })
  })

  it('does not flag a validator when the game pinned a different subset', () => {
    const game = { mine: false, subsetHash: subsetHashOf([V1, V2, PLAYER]) }
    expect(involvement(game, SUBSET, V2)).to.deep.equal({ played: false, validated: false })
  })

  it('a player who is also a canonical validator gets both flags', () => {
    const game = { mine: true, subsetHash: subsetHashOf(SUBSET) }
    expect(involvement(game, SUBSET, V1)).to.deep.equal({ played: true, validated: true })
  })

  it('no wallet, no involvement; unknown subset hash never validates', () => {
    expect(involvement({ mine: true, subsetHash: subsetHashOf(SUBSET) }, SUBSET, undefined)).to.deep.equal({
      played: false,
      validated: false,
    })
    expect(involvement({ mine: false, subsetHash: undefined }, SUBSET, V1)).to.deep.equal({
      played: false,
      validated: false,
    })
  })
})
