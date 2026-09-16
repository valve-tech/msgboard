import { describe, it, expect } from 'vitest'
import { describe as describeNotice } from '../src/components/LiveFeed'
import type { BoardNotice } from '../src/hooks/useBoardFeed'

// One sample payload per shape session-bots.ts (and the player-driven session hooks) actually post,
// per the 2026-07-28 "games-live-undefined" diagnosis. The bug was `describe()` only handling a couple
// of shapes and falling back to a `rounds`/`balance` template that interpolated the literal string
// "undefined" for every other game. Assert no shape ever renders "undefined", and that each renders
// sensible human text.
describe('LiveFeed describe()', () => {
  const noUndefined = (s: string) => expect(s).to.not.include('undefined')

  it('renders the single-draw (runDrawTable) summary shape: rounds/balance', () => {
    const n: BoardNotice = { kind: 'summary', game: 'dice', rounds: 255, balance: '40.99' }
    const s = describeNotice(n)
    noUndefined(s)
    expect(s).to.equal('played 255 rounds (balance 40.99)')
  })

  it('renders the mines open + summary shapes', () => {
    const open: BoardNotice = { kind: 'open', game: 'mines', commit: '0xabc', mines: 3, tiles: 25 }
    expect(describeNotice(open)).to.equal('opened a 25-tile / 3-mine board')
    const cashout: BoardNotice = { kind: 'summary', game: 'mines', reveals: 5, busted: false, multiplierX100: '198', delta: '0.98' }
    const s1 = describeNotice(cashout)
    noUndefined(s1)
    expect(s1).to.equal('cashed out 5 safe (0.98 net)')
    const bust: BoardNotice = { kind: 'summary', game: 'mines', reveals: 2, busted: true, multiplierX100: '0', delta: '-1' }
    const s2 = describeNotice(bust)
    noUndefined(s2)
    expect(s2).to.equal('hit a mine (-1 net)')
  })

  it('renders the ladder (runLadderTable) open + summary shape — towers/chicken/firewalk/heist/hilo-ladder/greedDice/cipher', () => {
    const open: BoardNotice = { kind: 'open', game: 'hilo-ladder', commit: '0xdead', maxSteps: 10 }
    noUndefined(describeNotice(open))
    expect(describeNotice(open)).to.equal('opened a climb (10 steps max)')
    const cashout: BoardNotice = { kind: 'summary', game: 'towers', steps: 4, busted: false, multiplierX100: '350', delta: '2.5' }
    const s1 = describeNotice(cashout)
    noUndefined(s1)
    expect(s1).to.equal('cashed out at step 4 (x3.50, 2.5 net)')
    const bust: BoardNotice = { kind: 'summary', game: 'cipher', steps: 2, busted: true, multiplierX100: '0', delta: '-1' }
    const s2 = describeNotice(bust)
    noUndefined(s2)
    expect(s2).to.equal('busted at step 2 (x0.00, -1 net)')
  })

  it('renders the decision one-shot (runDecisionTable) summary shape — blackjack/threeCardPoker/videoPoker/paiGow/roulette/wordle', () => {
    const n: BoardNotice = { kind: 'summary', game: 'blackjack', multiplierX100: '200', delta: '1', detail: 'player 20 vs dealer 19' }
    const s = describeNotice(n)
    noUndefined(s)
    expect(s).to.equal('player 20 vs dealer 19 (1 net)')
  })

  it('renders the Hi-Lo War duel open + summary shape, distinct from the hilo-ladder climb', () => {
    const open: BoardNotice = { kind: 'open', game: 'hilo-war', deck: '0xdeadbeef', escrowEach: '1' }
    const s0 = describeNotice(open)
    noUndefined(s0)
    expect(s0).to.equal('sat down to a Hi-Lo War table (escrow 1)')
    const n: BoardNotice = { kind: 'summary', game: 'hilo-war', flips: 12, balA: '1.5', balB: '0.5' }
    const s = describeNotice(n)
    noUndefined(s)
    expect(s).to.equal('settled after 12 flips (A 1.5 · B 0.5)')
  })

  it('renders the Sudoku leaderboard summary shape', () => {
    const n: BoardNotice = { kind: 'summary', game: 'sudoku', elapsed: '42', rank: 1 }
    const s = describeNotice(n)
    noUndefined(s)
    expect(s).to.equal('solved in 42s (rank 1)')
  })

  it('degrades gracefully instead of interpolating undefined when a shape is unrecognized', () => {
    const n: BoardNotice = { kind: 'summary', game: 'some-future-game' }
    const s = describeNotice(n)
    noUndefined(s)
    expect(s).to.equal('settled')
  })

  it('never renders the literal string "undefined" for any known bot payload shape, even with fields missing', () => {
    const shapes: BoardNotice[] = [
      { kind: 'summary', game: 'towers', steps: 3, busted: false }, // no multiplierX100/delta
      { kind: 'summary', game: 'mines', reveals: 1, busted: false }, // no delta
      { kind: 'open', game: 'hilo-war', deck: '0x1' }, // no escrowEach
      { kind: 'open', game: 'towers', commit: '0x1' }, // no maxSteps
      { kind: 'summary', game: 'blackjack', detail: 'push' }, // no delta
    ]
    for (const n of shapes) noUndefined(describeNotice(n))
  })
})
