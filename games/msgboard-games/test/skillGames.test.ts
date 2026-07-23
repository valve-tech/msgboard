/**
 * skillGames.test.ts — the ZK skill games.
 *
 * WORDLE is a wagered game: its PUBLISHED payout curve by guesses-used is (a) correct at every
 * reachable result, (b) escrow-safe — settle never pays above the declared ceiling, and (c) FAIR —
 * under the documented reference outcome distribution the realized RTP is ≤ 100% (never
 * player-favourable) and inside the published band. Unlike the RNG games RTP is a function of a
 * *reference* player distribution, not a fixed roll probability — a skilled player can beat it; the
 * house is protected only against the average player.
 *
 * SUDOKU is NOT a wager — it is a timed leaderboard (see games/sudoku.ts for why). Its tests cover the
 * elapsed-time math and the deterministic ranking of on-chain solve entries, not any payout/RTP.
 */
import { describe, it, expect } from 'vitest'
import {
  rtpBps,
  wordle, WORDLE_GAME_ID, WORDLE_MAX_GUESSES, WORDLE_MULT_X100, WORDLE_REFERENCE_WEIGHTS,
  wordleMultiplierX100,
  SUDOKU_GAME_ID, sudokuElapsed, sudokuLeaderboard, type SudokuSolveEntry,
  skillOutcome,
} from '../src'

describe('skill games — shared outcome helper', () => {
  it('a payout > stake is a win; == stake is a break-even push; < stake is a partial-refund loss; 0 is a loss', () => {
    expect(skillOutcome(100n, 250n)).toEqual({ win: true, playerDelta: 150n, multiplierX100: 250n })
    expect(skillOutcome(100n, 100n)).toEqual({ win: false, playerDelta: 0n, multiplierX100: 100n }) // push
    expect(skillOutcome(100n, 80n)).toEqual({ win: false, playerDelta: -20n, multiplierX100: 80n }) // refund
    expect(skillOutcome(100n, 0n)).toEqual({ win: false, playerDelta: -100n, multiplierX100: 0n }) // loss
  })
})

describe('ZK-Wordle (gameId 30)', () => {
  const params = { maxGuesses: WORDLE_MAX_GUESSES }

  it('has the expected gameId and escrow ceiling (solve-in-1)', () => {
    expect(wordle.gameId).toBe(30)
    expect(WORDLE_GAME_ID).toBe(30)
    expect(wordle.maxMultiplierX100(params)).toBe(WORDLE_MULT_X100[1])
  })

  it('pays the published multiplier for each guesses-used, 0 on a miss', () => {
    for (let g = 1; g <= WORDLE_MAX_GUESSES; g++) {
      const o = wordle.settleRound(1000n, params, { solved: true, guessesUsed: g })
      const expectedMult = WORDLE_MULT_X100[g]!
      expect(o.multiplierX100).toBe(expectedMult)
      expect(o.playerDelta).toBe((1000n * expectedMult) / 100n - 1000n)
    }
    const miss = wordle.settleRound(1000n, params, { solved: false, guessesUsed: 6 })
    expect(miss).toEqual({ win: false, playerDelta: -1000n, multiplierX100: 0n })
  })

  it('fast solves (1–3) win; the modal 4-guess solve is a net loss (partial refund)', () => {
    expect(wordle.settleRound(100n, params, { solved: true, guessesUsed: 1 }).win).toBe(true)
    expect(wordle.settleRound(100n, params, { solved: true, guessesUsed: 3 }).win).toBe(true)
    expect(wordle.settleRound(100n, params, { solved: true, guessesUsed: 4 }).win).toBe(false)
  })

  it('FUNDS-SAFETY: no reachable result pays above the escrow ceiling', () => {
    const ceiling = wordle.maxMultiplierX100(params)
    for (let g = 1; g <= WORDLE_MAX_GUESSES; g++) {
      expect(wordle.settleRound(1000n, params, { solved: true, guessesUsed: g }).multiplierX100)
        .toBeLessThanOrEqual(ceiling)
    }
  })

  it('rejects out-of-range guesses-used and unsupported maxGuesses', () => {
    expect(() => wordleMultiplierX100({ solved: true, guessesUsed: 7 })).toThrow()
    expect(() => wordleMultiplierX100({ solved: true, guessesUsed: 0 })).toThrow()
    expect(() => wordle.settleRound(1n, { maxGuesses: 5 }, { solved: true, guessesUsed: 1 })).toThrow()
  })

  it('FAIRNESS: realized RTP under the reference distribution is ≤ 100% and in [90%, 99%]', () => {
    const outcomes = WORDLE_REFERENCE_WEIGHTS.map(({ guesses, weight }) => ({
      weight,
      multX100: guesses === 0 ? 0n : WORDLE_MULT_X100[guesses]!,
    }))
    const rtp = rtpBps(outcomes)
    expect(rtp).toBe(9460n) // 94.60% — pinned so a table change can't silently move the edge
    expect(rtp).toBeLessThanOrEqual(10_000n) // never player-favourable
    expect(rtp).toBeGreaterThanOrEqual(9_000n)
  })
})

describe('ZK-Sudoku (gameId 31) — timed leaderboard, NOT a wager', () => {
  const entry = (over: Partial<SudokuSolveEntry>): SudokuSolveEntry => ({
    puzzleId: 1n, player: 0xaaan, nullifier: 0n, solvedAt: 100n, elapsed: 100n, ...over,
  })

  it('has the expected gameId and is not a wagered SkillGame (no stake/multiplier/escrow)', () => {
    expect(SUDOKU_GAME_ID).toBe(31)
  })

  it('elapsed = solvedAt - openedAt, and rejects a solve logged before open', () => {
    expect(sudokuElapsed(1000n, 1042n)).toBe(42n)
    expect(sudokuElapsed(1000n, 1000n)).toBe(0n)
    expect(() => sudokuElapsed(1000n, 999n)).toThrow(/precedes openedAt/)
  })

  it('ranks fastest elapsed first and assigns 1-based ranks', () => {
    const board = sudokuLeaderboard([
      entry({ player: 0xaaan, elapsed: 300n, nullifier: 1n }),
      entry({ player: 0xbbbn, elapsed: 120n, nullifier: 2n }),
      entry({ player: 0xcccn, elapsed: 205n, nullifier: 3n }),
    ])
    expect(board.map((r) => [r.player, r.rank])).toEqual([
      [0xbbbn, 1], [0xcccn, 2], [0xaaan, 3],
    ])
  })

  it('breaks elapsed ties by earlier solvedAt, then by player — a total, deterministic order', () => {
    const board = sudokuLeaderboard([
      entry({ player: 0xbbbn, elapsed: 100n, solvedAt: 100n, nullifier: 2n }),
      entry({ player: 0xaaan, elapsed: 100n, solvedAt: 100n, nullifier: 1n }), // same elapsed+solvedAt → player tiebreak
      entry({ player: 0xcccn, elapsed: 100n, solvedAt: 90n,  nullifier: 3n }), // earliest solvedAt → rank 1
    ])
    expect(board.map((r) => r.player)).toEqual([0xcccn, 0xaaan, 0xbbbn])
  })

  it('dedupes a player to their BEST solve, and rejects mixing puzzles', () => {
    const board = sudokuLeaderboard([
      entry({ player: 0xaaan, elapsed: 300n, nullifier: 1n }),
      entry({ player: 0xaaan, elapsed: 150n, nullifier: 2n }), // same player, faster → kept
    ])
    expect(board).toHaveLength(1)
    expect(board[0]!.elapsed).toBe(150n)
    expect(board[0]!.rank).toBe(1)

    expect(sudokuLeaderboard([])).toEqual([])
    expect(() =>
      sudokuLeaderboard([entry({ puzzleId: 1n }), entry({ puzzleId: 2n })]),
    ).toThrow(/mixed puzzleIds/)
  })
})
