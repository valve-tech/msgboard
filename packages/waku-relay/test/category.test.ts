import { describe, it, expect } from 'vitest'
import { keccak256, stringToBytes, stringToHex } from 'viem'
import { categoryHash } from '@msgboard/sdk'
import { categoryFor, isCategoryHash, parseCategoryEncoding } from '../src/category.js'

describe('category encoding', () => {
  it('default keccak256 matches the @msgboard/sdk categoryHash convention', () => {
    for (const name of ['lobby', 'games:dice', 'a-very-long-channel-name-over-thirty-two-bytes-xyz']) {
      expect(categoryFor(name)).toBe(keccak256(stringToBytes(name)))
      expect(categoryFor(name, 'keccak256')).toBe(categoryHash(name))
    }
  })

  it('ascii32 matches the relayer toCategoryHex convention (right-pad to 32 bytes)', () => {
    expect(categoryFor('lobby', 'ascii32')).toBe(stringToHex('lobby', { size: 32 }))
    expect(categoryFor('369', 'ascii32')).toBe(stringToHex('369', { size: 32 }))
  })

  it('the two encodings DISAGREE for the same name (why the flag matters)', () => {
    expect(categoryFor('lobby', 'keccak256')).not.toBe(categoryFor('lobby', 'ascii32'))
  })

  it('ascii32 rejects names longer than 32 bytes', () => {
    expect(() => categoryFor('x'.repeat(33), 'ascii32')).toThrow(/32/)
  })

  it('an already-resolved 32-byte hash passes through under either encoding', () => {
    const h = `0x${'ab'.repeat(32)}` as const
    expect(isCategoryHash(h)).toBe(true)
    expect(categoryFor(h, 'keccak256')).toBe(h)
    expect(categoryFor(h, 'ascii32')).toBe(h)
  })

  it('parseCategoryEncoding defaults to keccak256 and validates input', () => {
    expect(parseCategoryEncoding(undefined)).toBe('keccak256')
    expect(parseCategoryEncoding('')).toBe('keccak256')
    expect(parseCategoryEncoding('ascii32')).toBe('ascii32')
    expect(() => parseCategoryEncoding('nope')).toThrow()
  })
})
