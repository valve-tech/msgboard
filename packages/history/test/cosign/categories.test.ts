import { describe, expect, it } from 'vitest'
import { categoryKey, isoDay, keysForWindow } from '@msgboard/cosign'
import { resolveCategories } from '../../src/cosign/categories.js'

const NOW = new Date('2026-06-13T12:00:00.000Z')

describe('resolveCategories', () => {
  it('matches the cosign keysForWindow expansion (today-first, descending)', () => {
    const got = resolveCategories('cosign', 'wonderland', 7, NOW)
    const expected = keysForWindow('cosign', 'wonderland', 7, NOW)
    expect(got.map((c) => c.category)).toEqual(expected)
  })

  it('tags each category with its UTC isoDay', () => {
    const got = resolveCategories('cosign', 'wonderland', 3, NOW)
    expect(got.map((c) => c.isoDay)).toEqual(['2026-06-13', '2026-06-12', '2026-06-11'])
    // and the category hash for the tagged day round-trips through categoryKey
    expect(got[0].category).toBe(categoryKey('cosign', 'wonderland', '2026-06-13'))
  })

  it('rolls correctly across a UTC day boundary', () => {
    const justAfterMidnight = new Date('2026-06-13T00:00:01.000Z')
    const got = resolveCategories('cosign', 'wonderland', 2, justAfterMidnight)
    expect(got.map((c) => c.isoDay)).toEqual(['2026-06-13', '2026-06-12'])
    expect(got[0].category).toBe(categoryKey('cosign', 'wonderland', isoDay(justAfterMidnight)))
  })

  it('throws when days < 1 (delegating to keysForWindow)', () => {
    expect(() => resolveCategories('cosign', 'wonderland', 0, NOW)).toThrow(/days >= 1/)
  })
})
