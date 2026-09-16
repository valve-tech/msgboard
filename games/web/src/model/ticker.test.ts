import { describe, it, expect } from 'vitest'
import { summarizeWin } from './ticker'

describe('summarizeWin', () => {
  it('returns null for open notices', () => {
    expect(summarizeWin({ kind: 'open', game: 'dice', player: '0x7044000000000000000000000000000000009 5e5' })).toBeNull()
  })
  it('formats a mines cash-out with net delta', () => {
    const l = summarizeWin({ kind: 'summary', game: 'mines', reveals: 5, busted: false, delta: '12.4', player: '0xd8bd420000000000000000000000000000000000' })
    expect(l).not.toBeNull()
    expect(l!.game).toBe('mines')
    expect(l!.outcome).toContain('12.4')
    expect(l!.who).toMatch(/^0x/)
  })
  it('formats a decision detail line', () => {
    const l = summarizeWin({ kind: 'summary', game: 'blackjack', detail: 'paid 3:2', delta: '250' })
    expect(l!.outcome.toLowerCase()).toContain('3:2')
  })
  it('degrades to a generic outcome when fields are missing', () => {
    const l = summarizeWin({ kind: 'summary', game: 'dice' })
    expect(l).not.toBeNull()
    expect(l!.outcome.length).toBeGreaterThan(0)
  })
  it('short-addresses the player when present', () => {
    const l = summarizeWin({ kind: 'summary', game: 'dice', delta: '9.8', player: '0x7044aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa95e5' })
    expect(l!.who).toBe('0x7044…95e5')
  })
})
