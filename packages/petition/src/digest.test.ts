import { describe, it, expect } from 'vitest'
import { hashTypedData } from 'viem'
import {
  petitionDigest,
  PETITION_DOMAIN_NAME,
  PETITION_DOMAIN_VERSION,
  PETITION_TYPES,
} from './digest.js'

const vc = '0x2222222222222222222222222222222222222222'
const p = { id: ('0x' + 'ab'.repeat(32)) as any, statement: 'Save the park', chainId: 369 }

describe('digest', () => {
  it('matches viem hashTypedData', () => {
    const expected = hashTypedData({
      domain: {
        name: PETITION_DOMAIN_NAME,
        version: PETITION_DOMAIN_VERSION,
        chainId: 369,
        verifyingContract: vc,
      },
      types: PETITION_TYPES,
      primaryType: 'Petition',
      message: { petitionId: p.id, statement: p.statement },
    })
    expect(petitionDigest(p, vc)).toEqual(expected)
  })

  it('is chain-scoped', () => {
    expect(petitionDigest(p, vc)).not.toEqual(petitionDigest({ ...p, chainId: 943 }, vc))
  })

  it('is verifying-contract-scoped', () => {
    const vc2 = '0x3333333333333333333333333333333333333333'
    expect(petitionDigest(p, vc)).not.toEqual(petitionDigest(p, vc2))
  })
})
