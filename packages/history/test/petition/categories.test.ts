import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { categoryKey, isoDay, keysForWindow } from '@msgboard/cosign'
import { INDEX_SCOPE, PETITION_NS, signScope } from '@msgboard/petition'
import {
  resolveIndexCategories,
  resolveSignatureCategories,
} from '../../src/petition/categories.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')
const id = `0x${'ab'.repeat(32)}` as Hex

describe('resolveIndexCategories', () => {
  it('matches keysForWindow(PETITION_NS, INDEX_SCOPE, ...) (today-first, descending)', () => {
    const got = resolveIndexCategories(7, NOW)
    const expected = keysForWindow(PETITION_NS, INDEX_SCOPE, 7, NOW)
    expect(got.map((c) => c.category)).toEqual(expected)
    expect(got.map((c) => c.isoDay)).toEqual([
      '2026-06-13',
      '2026-06-12',
      '2026-06-11',
      '2026-06-10',
      '2026-06-09',
      '2026-06-08',
      '2026-06-07',
    ])
  })

  it("tags today's category with categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(now))", () => {
    const got = resolveIndexCategories(1, NOW)
    expect(got[0].category).toBe(categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(NOW)))
  })
})

describe('resolveSignatureCategories', () => {
  it('matches keysForWindow(PETITION_NS, signScope(id), ...)', () => {
    const got = resolveSignatureCategories(id, 3, NOW)
    const expected = keysForWindow(PETITION_NS, signScope(id), 3, NOW)
    expect(got.map((c) => c.category)).toEqual(expected)
  })

  it('lowercases the id via signScope (case-insensitive petition ids)', () => {
    const upper = `0x${'AB'.repeat(32)}` as Hex
    const lower = `0x${'ab'.repeat(32)}` as Hex
    const gotUpper = resolveSignatureCategories(upper, 1, NOW)
    const gotLower = resolveSignatureCategories(lower, 1, NOW)
    expect(gotUpper.map((c) => c.category)).toEqual(gotLower.map((c) => c.category))
  })
})
