import { describe, it, expect } from 'vitest'
import { derivePetitionId, encodePetition, decodePetition, type Petition } from './descriptor.js'

const salt = ('0x' + '11'.repeat(32)) as `0x${string}`
const creator = '0x1111111111111111111111111111111111111111'

describe('descriptor', () => {
  it('petitionId is deterministic and binds inputs', () => {
    const a = derivePetitionId('Save the park', creator, salt)
    const b = derivePetitionId('Save the park', creator, salt)
    const c = derivePetitionId('Save the park', creator, ('0x' + '22'.repeat(32)) as any)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('descriptor round-trips', () => {
    const p: Petition = {
      id: derivePetitionId('S', creator, salt),
      statement: 'S',
      creator,
      createdAt: 1730000000,
      chainId: 369,
      salt,
    }
    expect(decodePetition(encodePetition(p))).toEqual(p)
  })
})
