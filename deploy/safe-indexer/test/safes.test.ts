import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import {
  norm,
  safeRowId,
  ownerRowId,
  setupOwnerRows,
  addedOwnerRow,
  ownerSafesResponse,
} from '../src/safes'

// Fixtures — a Safe with two initial owners on chain 369.
const CHAIN = 369
const SAFE = '0xAbC0000000000000000000000000000000000001' as const
const OWNER_A = '0x1111111111111111111111111111111111111111' as const
const OWNER_B = '0x2222222222222222222222222222222222222222' as const

describe('norm', () => {
  it('lowercases an address', () => expect(norm(SAFE)).toBe(SAFE.toLowerCase()))
})

describe('safeRowId', () => {
  it('keys by chainId:safe (lowercased) — so CREATE2 collisions across chains do not clash', () => {
    expect(safeRowId(CHAIN, SAFE)).toBe(`369:${SAFE.toLowerCase()}`)
    expect(safeRowId(943, SAFE)).toBe(`943:${SAFE.toLowerCase()}`)
    expect(safeRowId(CHAIN, SAFE)).not.toBe(safeRowId(943, SAFE))
  })
})

describe('ownerRowId', () => {
  it('keys by chainId:safe:owner (all lowercased)', () => {
    expect(ownerRowId(CHAIN, SAFE, OWNER_A)).toBe(`369:${SAFE.toLowerCase()}:${OWNER_A.toLowerCase()}`)
  })
  it('differs per owner and per safe', () => {
    expect(ownerRowId(CHAIN, SAFE, OWNER_A)).not.toBe(ownerRowId(CHAIN, SAFE, OWNER_B))
  })
})

describe('setupOwnerRows', () => {
  const rows = setupOwnerRows({ chainId: CHAIN, safe: SAFE, owners: [OWNER_A, OWNER_B], block: 100n })

  it('emits one row per owner', () => expect(rows).toHaveLength(2))
  it('sets deterministic ids', () => {
    expect(rows[0]!.id).toBe(ownerRowId(CHAIN, SAFE, OWNER_A))
    expect(rows[1]!.id).toBe(ownerRowId(CHAIN, SAFE, OWNER_B))
  })
  it('normalises safe + owner to lowercase', () => {
    expect(rows[0]!.safe).toBe(SAFE.toLowerCase())
    expect(rows[0]!.owner).toBe(OWNER_A.toLowerCase())
  })
  it('stamps chainId + addedBlock', () => {
    expect(rows[0]!.chainId).toBe(CHAIN)
    expect(rows[0]!.addedBlock).toBe(100n)
  })
})

describe('addedOwnerRow', () => {
  const row = addedOwnerRow({ chainId: CHAIN, safe: SAFE, owner: OWNER_A, block: 200n })
  it('matches the setupOwnerRows id for the same edge (idempotent add)', () => {
    expect(row.id).toBe(ownerRowId(CHAIN, SAFE, OWNER_A))
  })
  it('carries the block it was added at', () => expect(row.addedBlock).toBe(200n))
})

describe('ownerSafesResponse — the Safe Tx Service shape', () => {
  it('returns { safes: [...] } with CHECKSUMMED addresses', () => {
    const res = ownerSafesResponse([{ safe: SAFE.toLowerCase() }])
    expect(res).toEqual({ safes: [getAddress(SAFE)] })
    // checksummed, not the lowercased input
    expect(res.safes[0]).toBe(getAddress(SAFE))
    expect(res.safes[0]).not.toBe(SAFE.toLowerCase())
  })

  it('dedupes safes (an owner listed via SafeSetup + AddedOwner yields one entry)', () => {
    const res = ownerSafesResponse([
      { safe: SAFE.toLowerCase() },
      { safe: SAFE.toUpperCase().replace('0X', '0x') },
      { safe: '0xabc0000000000000000000000000000000000002' },
    ])
    expect(res.safes).toHaveLength(2)
    expect(res.safes).toContain(getAddress(SAFE))
    expect(res.safes).toContain(getAddress('0xabc0000000000000000000000000000000000002'))
  })

  it('returns an empty list for an owner with no safes', () => {
    expect(ownerSafesResponse([])).toEqual({ safes: [] })
  })
})
