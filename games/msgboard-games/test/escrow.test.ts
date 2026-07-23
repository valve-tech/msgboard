import { describe, it, expect } from 'vitest'
import { diceMaxMultiplierX100, escrowFor } from '../src/escrow'
import { dice } from '../src/games/dice'

describe('dice escrow sizing', () => {
  it('a 50% roll-under target pays ~1.98x after the 1% edge', () => {
    // fair = 100/50 = 2.00x; with EDGE_BPS=100 → 0.99 * 2.00 = 1.98x → 198 (hundredths)
    expect(diceMaxMultiplierX100({ targetX100: 5000n })).toBe(198n)
  })

  it('escrowHouse covers exactly the player win above their own stake', () => {
    const { escrowPlayer, escrowHouse } = escrowFor(1_000n, 198n)
    expect(escrowPlayer).toBe(1_000n)        // player brings their stake
    expect(escrowHouse).toBe(980n)           // 1000 * (198-100)/100 = 980
    // total locked 1980 == stake * 1.98x; on a win the player can take all of it
  })

  it('escrowHouse equals the EXACT win delta settleRound pays, across stakes and targets', () => {
    // Funds-safety invariant (audit finding C): the house must lock at least the player's max
    // profit, or a real win underflows balanceHouse and becomes un-cosignable. escrowFor and
    // settleRound floor independently, so assert they agree for every stake/target — any future
    // divergence (e.g. a changed HUNDREDTHS) trips here instead of silently locking a winner out.
    const targets = [1n, 100n, 1234n, 5000n, 5450n, 9899n]
    const stakes = [1n, 7n, 100n, 999n, 1_000n, 123_456_789n]
    for (const targetX100 of targets) {
      const mult = diceMaxMultiplierX100({ targetX100 })
      for (const stake of stakes) {
        // Dice pays a FIXED multiplier per target, so every win pays identically — one winning raw
        // per (stake,target) fully characterizes the max payout. A variable-payout game reusing
        // escrowFor would need escrowHouse sized to its MAX win, not a single sampled win.
        const winningRaw = targetX100 - 1n // strictly under target ⇒ guaranteed win (roll = raw % 10000)
        const outcome = dice.settleRound(stake, { targetX100 }, winningRaw)
        expect(outcome.win).toBe(true)
        const { escrowHouse } = escrowFor(stake, mult)
        expect(escrowHouse).toBe(outcome.playerDelta) // exact: house covers the whole win, no more, no less
      }
    }
  })
})
