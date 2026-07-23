import { describe, it, expect } from 'vitest'
import { dragonTiger, dealDragonTiger, type DragonTigerBet } from '../src/games/dragonTiger'
import { dragonTigerRank } from '../src/cards'

const STAKE = 1_000_000n

describe('dragon tiger', () => {
  it('higher card (ace low) wins; equal rank is a tie', () => {
    for (let raw = 0n; raw < 400n; raw++) {
      const d = dealDragonTiger(raw)
      expect(d.dragon).not.toBe(d.tiger)
      const dr = dragonTigerRank(d.dragon)
      const tr = dragonTigerRank(d.tiger)
      const expected = dr > tr ? 'dragon' : tr > dr ? 'tiger' : 'tie'
      expect(d.winner).toBe(expected)
    }
  })

  it('pays dragon/tiger 1:1 and tie 11:1', () => {
    expect(dragonTiger.maxMultiplierX100({ bet: 'dragon' })).toBe(200n)
    expect(dragonTiger.maxMultiplierX100({ bet: 'tiger' })).toBe(200n)
    expect(dragonTiger.maxMultiplierX100({ bet: 'tie' })).toBe(1200n)
  })

  it('dragon/tiger bet loses half on a tie', () => {
    let found = false
    for (let raw = 0n; raw < 5000n && !found; raw++) {
      if (dealDragonTiger(raw).winner === 'tie') {
        const r = dragonTiger.settleRound(STAKE, { bet: 'dragon' }, raw)
        expect(r.win).toBe(false)
        expect(r.playerDelta).toBe(-STAKE / 2n) // lose half
        // tie bet wins big on the same raw
        const t = dragonTiger.settleRound(STAKE, { bet: 'tie' }, raw)
        expect(t.win).toBe(true)
        expect(t.multiplierX100).toBe(1200n)
        found = true
      }
    }
    expect(found).toBe(true)
  })

  it('settles win/loss against the deal for all bets', () => {
    for (const bet of ['dragon', 'tiger', 'tie'] as DragonTigerBet[]) {
      for (let raw = 0n; raw < 200n; raw++) {
        const { winner } = dealDragonTiger(raw)
        const r = dragonTiger.settleRound(STAKE, { bet }, raw)
        if (winner === bet) {
          expect(r.win).toBe(true)
          expect(r.multiplierX100).toBe(dragonTiger.maxMultiplierX100({ bet }))
        } else if (winner === 'tie' && bet !== 'tie') {
          expect(r.playerDelta).toBe(-STAKE / 2n)
        } else {
          expect(r.playerDelta).toBe(-STAKE)
        }
      }
    }
  })
})
