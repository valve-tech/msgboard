import { describe, it, expect } from 'vitest'
import { foldSolves, type SolveRow } from '../src/hooks/useStandings'

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const solve = (solver: string, game: string, blockTimestamp: string): SolveRow => ({ solver, game, blockTimestamp })

describe('foldSolves', () => {
  it('counts solves per player and per game', () => {
    const rows = foldSolves([
      solve(A, 'sudoku', '100'),
      solve(A, 'wordle', '200'),
      solve(A, 'sudoku', '300'),
      solve(B, 'wordle', '150'),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.solves).toBe(3)
    expect(rows[0]!.byGame).toEqual({ sudoku: 2, wordle: 1 })
    expect(rows[0]!.lastAt).toBe(300)
    expect(rows[1]!.solves).toBe(1)
  })

  it('ranks by solve count, most-recent-solve as the tiebreak', () => {
    const rows = foldSolves([
      solve(A, 'sudoku', '100'),
      solve(B, 'wordle', '999'), // same count as A, but fresher → ranks first
    ])
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
    expect(rows[0]!.player.toLowerCase()).toBe(B)
  })

  it('folds mixed-case solver addresses into one row, checksummed out', () => {
    const rows = foldSolves([solve(A, 'sudoku', '1'), solve(A.toUpperCase().replace('0X', '0x'), 'sudoku', '2')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.solves).toBe(2)
    expect(rows[0]!.player).not.toBe(A) // getAddress checksums it
    expect(rows[0]!.player.toLowerCase()).toBe(A)
  })

  it('returns empty for no solves', () => {
    expect(foldSolves([])).toEqual([])
  })
})
