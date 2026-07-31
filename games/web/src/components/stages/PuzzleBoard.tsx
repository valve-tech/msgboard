import type { ReactNode } from 'react'

/**
 * PuzzleBoard — the shared immersive frame for the ZK puzzle games (Wordle, Sudoku). Unlike the house
 * surfaces there's no round `raw` to animate: these are non-wagered skill games where a player proves a
 * solution in-browser (a PLONK proof in a Web Worker) and posts it. So the "stage" is just the board
 * itself, centred and full-bleed, with a slim status header above it.
 *
 * Purely a frame: every grid, control, proof handler and leaderboard lives in the screen. This owns the
 * backdrop (tinted per game via `tone`), the header slot, and the centred board slot — nothing more, so
 * the honest, interactive grid each game renders sits unchanged inside it.
 */
export const PuzzleBoard = ({ tone = 'wordle', head, children }: {
  /** background tint — 'wordle' (slate-green) or 'sudoku' (slate-brass). */
  tone?: 'wordle' | 'sudoku'
  /** slim status line pinned above the board (verified-hash notice, validity hint, phase). */
  head?: ReactNode
  /** the board the screen renders (tile grid, 9×9, activity log, or a waiting state). */
  children: ReactNode
}) => (
  <div className={`puz-scene puz-${tone}`}>
    {head && <div className="puz-head">{head}</div>}
    <div className="puz-slot">{children}</div>
  </div>
)
