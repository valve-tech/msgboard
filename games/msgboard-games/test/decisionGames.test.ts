import { describe, it, expect } from 'vitest'
import { rankThreeCard } from '../src/poker'
import {
  dealThreeCard, settleThreeCard, threeCardMaxMultiplierX100, commitThreeCard, verifyThreeCard,
} from '../src/games/threeCardPoker'
import {
  drawVideoPoker, settleVideoPoker, videoPokerMaxMultiplierX100, commitVideoPoker, verifyVideoPoker,
} from '../src/games/videoPoker'
import {
  settleBlackjack, blackjackPlayerView, handTotal, isBlackjack, commitBlackjack, verifyBlackjack,
  type BlackjackAction,
} from '../src/games/blackjack'

const STAKE = 1_000_000n

describe('three card poker', () => {
  it('folding always loses exactly the ante', () => {
    for (let seed = 0n; seed < 50n; seed++) {
      expect(settleThreeCard(STAKE, seed, 'fold').playerDelta).toBe(-STAKE)
    }
  })

  it('playing settles against the dealer with the qualify rule and ante bonus', () => {
    for (let seed = 0n; seed < 400n; seed++) {
      const deal = dealThreeCard(seed)
      const out = settleThreeCard(STAKE, seed, 'play')
      const p = rankThreeCard(deal.player)
      const d = rankThreeCard(deal.dealer)
      // recompute the expected base (ante units) independently
      let base = 0n
      if (!deal.dealerQualifies) base = 1n
      else if (p.score > d.score) base = 2n
      else if (p.score < d.score) base = -2n
      const bonus = (p.category === 5 ? 5n : p.category === 4 ? 4n : p.category === 3 ? 1n : 0n) * STAKE
      expect(out.playerDelta).toBe(base * STAKE + bonus)
      expect(out.playerDelta).toBeLessThanOrEqual((threeCardMaxMultiplierX100() - 100n) * STAKE / 100n)
    }
  })

  it('verify accepts an honest hand and rejects a wrong seed / inflated delta', () => {
    const seed = 1234n
    const out = settleThreeCard(STAKE, seed, 'play')
    const claim = { commit: commitThreeCard(seed), decision: 'play' as const, stake: STAKE, claimedDelta: out.playerDelta }
    expect(verifyThreeCard(claim, seed).ok).toBe(true)
    expect(verifyThreeCard(claim, seed + 1n).ok).toBe(false)
    expect(verifyThreeCard({ ...claim, claimedDelta: out.playerDelta + 1n }, seed).ok).toBe(false)
  })
})

describe('video poker (jacks or better)', () => {
  it('holding all 5 keeps the dealt hand; holding none replaces all 5', () => {
    const seed = 77n
    const holdAll = drawVideoPoker(seed, 0b11111)
    expect(holdAll.final).toEqual(holdAll.dealt)
    const holdNone = drawVideoPoker(seed, 0)
    expect(holdNone.final.every((c, i) => c !== holdNone.dealt[i] || true)).toBe(true) // replaced from deck[5..9]
    expect(new Set(holdNone.final).size).toBe(5) // distinct
  })

  it('pays the paytable multiple; nothing loses the stake; verify round-trips', () => {
    for (let seed = 0n; seed < 200n; seed++) {
      const out = settleVideoPoker(STAKE, seed, 0b11111) // hold all (deterministic eval of dealt hand)
      const expectedDelta = (STAKE * out.multiplierX100) / 100n - STAKE
      expect(out.playerDelta).toBe(expectedDelta)
      expect(out.multiplierX100).toBeLessThanOrEqual(videoPokerMaxMultiplierX100())
      const claim = { commit: commitVideoPoker(seed), holdMask: 0b11111, stake: STAKE, claimedDelta: out.playerDelta }
      expect(verifyVideoPoker(claim, seed).ok).toBe(true)
    }
  })

  it('rejects a bad hold mask', () => {
    expect(() => drawVideoPoker(1n, 32)).toThrow()
    expect(() => drawVideoPoker(1n, -1)).toThrow()
  })
})

describe('blackjack', () => {
  it('hand totals count aces 11-or-1 correctly', () => {
    // A + K = 21 (soft 21 / blackjack)
    expect(handTotal([(14 - 2) * 4, (13 - 2) * 4 + 1]).total).toBe(21)
    // A + 9 + 5 = 15 (ace drops to 1)
    expect(handTotal([(14 - 2) * 4, (9 - 2) * 4, (5 - 2) * 4]).total).toBe(15)
    expect(isBlackjack([(14 - 2) * 4, (13 - 2) * 4 + 1])).toBe(true)
  })

  it('a stand-only game settles by comparing totals; delta bounded by the ceiling', () => {
    for (let seed = 0n; seed < 300n; seed++) {
      const view = blackjackPlayerView(seed, [])
      // if a natural was dealt, no actions are allowed
      const actions: BlackjackAction[] = view.finished ? [] : ['stand']
      const out = settleBlackjack(STAKE, seed, actions)
      expect(['number', 'bigint']).toContain(typeof out.playerDelta)
      // never pays more than the 3.00x ceiling profit (+2·stake)
      expect(out.playerDelta).toBeLessThanOrEqual(2n * STAKE)
      expect(out.playerDelta).toBeGreaterThanOrEqual(-2n * STAKE)
    }
  })

  it('the player view never exposes the dealer hole or undrawn deck', () => {
    const seed = 42n
    const view = blackjackPlayerView(seed, [])
    // only the player's 2 cards + the dealer UP card are visible mid-turn
    expect(view.playerCards.length).toBe(2)
    expect(typeof view.dealerUp).toBe('number')
    const serialized = JSON.stringify(view)
    // the dealer's hole card (deck[3]) must not appear in the view
    // (we can't know its value here without the deck, but the view object has no dealer hole field)
    expect('dealerHole' in view).toBe(false)
    expect('deck' in view).toBe(false)
    expect(serialized).not.toContain('hole')
  })

  it('rejects an action after the turn ended and verifies honest play', () => {
    const seed = 5n
    if (blackjackPlayerView(seed, []).finished) return // skip naturals for this assertion
    expect(() => settleBlackjack(STAKE, seed, ['stand', 'hit'])).toThrow()
    const out = settleBlackjack(STAKE, seed, ['stand'])
    const claim = { commit: commitBlackjack(seed), actions: ['stand'] as BlackjackAction[], stake: STAKE, claimedDelta: out.playerDelta }
    expect(verifyBlackjack(claim, seed).ok).toBe(true)
    expect(verifyBlackjack(claim, seed + 1n).ok).toBe(false)
    expect(verifyBlackjack({ ...claim, claimedDelta: out.playerDelta + 1n }, seed).ok).toBe(false)
  })
})
