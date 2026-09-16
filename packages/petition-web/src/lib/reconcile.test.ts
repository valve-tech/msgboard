import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { outstanding } from './reconcile.js'

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Hex
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Hex
const C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as Hex

describe('outstanding', () => {
  it('returns captured signers not present in settled', () => {
    expect(outstanding([A, B, C], [B])).toEqual([A, C])
  })

  it('is case-insensitive when comparing captured vs settled addresses', () => {
    expect(outstanding([A], [A.toLowerCase() as Hex])).toEqual([])
    expect(outstanding([A.toLowerCase() as Hex], [A])).toEqual([])
  })

  it('returns everything captured when settled is empty', () => {
    expect(outstanding([A, B], [])).toEqual([A, B])
  })

  it('returns empty when captured is empty', () => {
    expect(outstanding([], [A, B])).toEqual([])
  })

  it('dedupes captured entries that repeat', () => {
    expect(outstanding([A, A, B], [])).toEqual([A, B])
  })

  it('preserves the original captured order (minus removed/duplicate entries)', () => {
    expect(outstanding([C, A, B], [A])).toEqual([C, B])
  })
})
