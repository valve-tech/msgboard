import { describe, it, expect } from 'vitest'

import {
  MAX_STATEMENT_LENGTH,
  statementFromHeadline,
  statementsFromHeadlines,
} from './statements.js'

describe('statementFromHeadline', () => {
  it('turns a headline into a petition the board can carry', () => {
    const s = statementFromHeadline('Regulators approve the merger')
    expect(s).toContain('Regulators approve the merger')
    expect(s.startsWith('We petition the board')).toBe(true)
  })

  it('is deterministic, because the petition id derives from the statement', () => {
    // Same statement -> same salt -> same id -> `petitionsNeedingCreation` sees
    // it already exists. A generator that varied its wording would recreate the
    // same petition every tick and flood the board.
    const a = statementFromHeadline('Regulators approve the merger')
    const b = statementFromHeadline('Regulators approve the merger')
    expect(a).toBe(b)
  })

  it('collapses whitespace and strips control characters', () => {
    // Headlines arrive from a third-party feed. They reach a PoW-stamped board
    // post, so they are untrusted input, not display text.
    const s = statementFromHeadline('  Line\u0000one\n\tand   two  ')
    expect(s).not.toMatch(/[\x00-\x1F\x7F]/)
    expect(s).not.toMatch(/\s{2,}/)
    expect(s).toContain('Line one and two')
  })

  it('rejects a headline that is too short to mean anything', () => {
    expect(statementFromHeadline('hi')).toBeNull()
    expect(statementFromHeadline('   ')).toBeNull()
  })

  it('never exceeds the statement length cap', () => {
    const s = statementFromHeadline('x'.repeat(1000))
    expect(s).not.toBeNull()
    expect(s!.length).toBeLessThanOrEqual(MAX_STATEMENT_LENGTH)
  })

  it('does not cut a truncated headline mid-word', () => {
    const long = `${'word '.repeat(80)}end`
    const s = statementFromHeadline(long)!
    expect(s.length).toBeLessThanOrEqual(MAX_STATEMENT_LENGTH)
    expect(s).not.toMatch(/wor…|wo…/)
  })
})

describe('statementsFromHeadlines', () => {
  it('keeps order, drops rejects, and dedupes', () => {
    const out = statementsFromHeadlines([
      'Regulators approve the merger',
      'hi',
      'Regulators approve the merger',
      'A second real headline here',
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('Regulators approve the merger')
    expect(out[1]).toContain('A second real headline here')
  })

  it('caps how many it returns, so one tick cannot flood the board', () => {
    const many = Array.from({ length: 50 }, (_, i) => `Headline number ${i} about something`)
    expect(statementsFromHeadlines(many, { max: 3 })).toHaveLength(3)
  })

  it('returns nothing for an empty or all-junk feed', () => {
    expect(statementsFromHeadlines([])).toEqual([])
    expect(statementsFromHeadlines(['', 'a', '  '])).toEqual([])
  })
})
