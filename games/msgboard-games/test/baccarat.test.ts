import { describe, it, expect } from 'vitest'
import { baccarat, dealBaccarat, type BaccaratBet } from '../src/games/baccarat'
import { baccaratValue } from '../src/cards'

const STAKE = 1_000_000n

/** recompute the pip total of a hand mod 10 — independent of the module's private helper. */
const handTotal = (cards: number[]): number => cards.reduce((s, c) => s + baccaratValue(c), 0) % 10

describe('baccarat (punto banco)', () => {
  it('deals legal hands and a consistent winner for many seeds', () => {
    for (let raw = 0n; raw < 400n; raw++) {
      const d = dealBaccarat(raw)
      // 2 or 3 cards per hand; naturals (8/9) never draw a third
      expect(d.playerCards.length === 2 || d.playerCards.length === 3).toBe(true)
      expect(d.bankerCards.length === 2 || d.bankerCards.length === 3).toBe(true)
      expect(d.playerTotal).toBe(handTotal(d.playerCards))
      expect(d.bankerTotal).toBe(handTotal(d.bankerCards))
      const expected =
        d.playerTotal > d.bankerTotal ? 'player' : d.bankerTotal > d.playerTotal ? 'banker' : 'tie'
      expect(d.winner).toBe(expected)
      // all dealt cards distinct (drawn from one shuffled deck)
      const all = [...d.playerCards, ...d.bankerCards]
      expect(new Set(all).size).toBe(all.length)
    }
  })

  it('a natural (first-two 8 or 9) stands — no third card for either hand', () => {
    for (let raw = 0n; raw < 2000n; raw++) {
      const d = dealBaccarat(raw)
      const pNat = handTotal(d.playerCards.slice(0, 2)) >= 8
      const bNat = handTotal(d.bankerCards.slice(0, 2)) >= 8
      if (pNat || bNat) {
        expect(d.playerCards.length).toBe(2)
        expect(d.bankerCards.length).toBe(2)
      }
    }
  })

  it('pays player 1:1, banker 0.95:1, tie 8:1; ceilings match', () => {
    expect(baccarat.maxMultiplierX100({ bet: 'player' })).toBe(200n)
    expect(baccarat.maxMultiplierX100({ bet: 'banker' })).toBe(195n)
    expect(baccarat.maxMultiplierX100({ bet: 'tie' })).toBe(900n)
  })

  it('settles win / loss / push correctly against the deal', () => {
    for (const bet of ['player', 'banker', 'tie'] as BaccaratBet[]) {
      for (let raw = 0n; raw < 300n; raw++) {
        const { winner } = dealBaccarat(raw)
        const r = baccarat.settleRound(STAKE, { bet }, raw)
        if (winner === 'tie' && bet !== 'tie') {
          expect(r.playerDelta).toBe(0n) // push
          expect(r.win).toBe(false)
        } else if (winner === bet) {
          expect(r.win).toBe(true)
          expect(r.playerDelta).toBeGreaterThan(0n)
          expect(r.multiplierX100).toBeLessThanOrEqual(baccarat.maxMultiplierX100({ bet }))
        } else {
          expect(r.win).toBe(false)
          expect(r.playerDelta).toBe(-STAKE)
        }
      }
    }
  })

  it('banker win pays exactly 0.95x profit (5% commission)', () => {
    // find a seed where banker wins and a banker bet is placed
    let found = false
    for (let raw = 0n; raw < 500n && !found; raw++) {
      if (dealBaccarat(raw).winner === 'banker') {
        const r = baccarat.settleRound(STAKE, { bet: 'banker' }, raw)
        expect(r.playerDelta).toBe((STAKE * 195n) / 100n - STAKE) // 0.95x stake
        found = true
      }
    }
    expect(found).toBe(true)
  })
})
