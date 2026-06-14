import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { categoryKey, currentKey, isoDay, keysForWindow } from '../src/keys.js'

describe('isoDay', () => {
  it('formats a date as UTC YYYY-MM-DD', () => {
    expect(isoDay(new Date('2026-06-13T12:34:56.000Z'))).toBe('2026-06-13')
  })

  it('uses UTC, not local time, across a day boundary', () => {
    // 2026-06-13T23:30 in UTC-05 is still 2026-06-14T04:30 UTC.
    expect(isoDay(new Date('2026-06-14T04:30:00.000Z'))).toBe('2026-06-14')
    // One minute before midnight UTC is still the 13th.
    expect(isoDay(new Date('2026-06-13T23:59:59.999Z'))).toBe('2026-06-13')
    // One minute after midnight UTC has rolled to the 14th.
    expect(isoDay(new Date('2026-06-14T00:00:00.001Z'))).toBe('2026-06-14')
  })
})

describe('categoryKey', () => {
  it('is deterministic and equals keccak256(toBytes("ns:scope:isoDate"))', () => {
    const expected = keccak256(toBytes('cosign:acme:2026-06-13'))
    expect(categoryKey('cosign', 'acme', '2026-06-13')).toBe(expected)
    expect(categoryKey('cosign', 'acme', '2026-06-13')).toBe(
      categoryKey('cosign', 'acme', '2026-06-13'),
    )
  })

  it('is sensitive to namespace', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('multisig', 'acme', '2026-06-13'),
    )
  })

  it('is sensitive to scope', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('cosign', 'beta', '2026-06-13'),
    )
  })

  it('is sensitive to date', () => {
    expect(categoryKey('cosign', 'acme', '2026-06-13')).not.toBe(
      categoryKey('cosign', 'acme', '2026-06-14'),
    )
  })
})

describe('currentKey', () => {
  it('keys to the UTC day of the injected now', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    expect(currentKey('cosign', 'acme', now)).toBe(categoryKey('cosign', 'acme', '2026-06-13'))
  })
})

describe('keysForWindow', () => {
  it('returns exactly `days` keys, today-first then descending', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    const keys = keysForWindow('cosign', 'acme', 3, now)
    expect(keys).toHaveLength(3)
    expect(keys).toEqual([
      categoryKey('cosign', 'acme', '2026-06-13'),
      categoryKey('cosign', 'acme', '2026-06-12'),
      categoryKey('cosign', 'acme', '2026-06-11'),
    ])
  })

  it('crosses a month boundary correctly (UTC)', () => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    const keys = keysForWindow('cosign', 'acme', 2, now)
    expect(keys).toEqual([
      categoryKey('cosign', 'acme', '2026-07-01'),
      categoryKey('cosign', 'acme', '2026-06-30'),
    ])
  })

  it('returns a single key for days=1', () => {
    const now = new Date('2026-06-13T08:00:00.000Z')
    expect(keysForWindow('cosign', 'acme', 1, now)).toEqual([
      categoryKey('cosign', 'acme', '2026-06-13'),
    ])
  })

  it('throws when days < 1', () => {
    expect(() => keysForWindow('cosign', 'acme', 0)).toThrow(/days >= 1/)
    expect(() => keysForWindow('cosign', 'acme', -3)).toThrow(/days >= 1/)
  })
})
