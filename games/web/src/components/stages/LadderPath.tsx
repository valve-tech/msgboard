import type { ReactNode } from 'react'

/**
 * LadderPath — the stage surface for the stateful climb games (Towers, Hi-Lo, Chicken, Firewalk,
 * Heist, Cipher). A vertical tower of rungs you ascend: climbed rungs are settled (green, with the
 * game's own marker), the current rung is live and hosts the game's choice controls, rungs above are
 * locked. A summit cap crowns the top. Game-agnostic — each screen feeds `steps`, the live
 * `current`/`status`, per-rung multiplier + marker callbacks, and the current-step `choices` node.
 */
export const LadderPath = ({
  steps, current, status, bustedStep, multAt, markAt, choices, currentLabel, summit,
}: {
  steps: number
  /** the current step index (session.step): rungs below are climbed, this one is live. */
  current: number
  status: 'idle' | 'playing' | 'busted' | 'cashed'
  /** rung index where a bust happened (defaults to `current`). */
  bustedStep?: number
  /** multiplier label for rung i (e.g. "1.32x"). */
  multAt?: (i: number) => string
  /** marker for a climbed rung i (e.g. the chosen tile / a higher-lower arrow). Defaults to ✓. */
  markAt?: (i: number) => ReactNode
  /** the live rung's choice controls (tappable) — pick a tile, higher/lower, advance, … */
  choices?: ReactNode
  /** short label on the live rung (e.g. "floor 3" or Hi-Lo's current card). */
  currentLabel?: ReactNode
  /** crown shown on the summit cap (e.g. the max multiplier). */
  summit?: ReactNode
}) => {
  const rows = Array.from({ length: steps }, (_, k) => steps - 1 - k) // render top → bottom
  const done = status === 'cashed'
  return (
    <div className="lad-scene">
      <div className="lad-path">
        <div className={`lad-summit${done ? ' win' : ''}`}>
          <span className="lad-summit-mark">◈</span>
          <span className="lad-summit-label">{done ? 'cashed out' : (summit ?? 'summit')}</span>
        </div>
        {rows.map((i) => {
          const climbed = status !== 'idle' && i < current
          const isLive = status === 'playing' && i === current
          const busted = status === 'busted' && i === (bustedStep ?? current)
          const cls = busted ? 'bust' : climbed ? 'done' : isLive ? 'live' : 'lock'
          return (
            <div className={`lad-rung ${cls}`} key={i}>
              <span className="lad-mult">{multAt ? multAt(i) : `#${i + 1}`}</span>
              <span className="lad-node" aria-hidden />
              <div className="lad-cell">
                {busted ? (
                  <span className="lad-cell-x">✗ busted here</span>
                ) : climbed ? (
                  <span className="lad-cell-ok">{markAt ? markAt(i) : '✓'}</span>
                ) : isLive ? (
                  <div className="lad-cell-live">
                    {currentLabel && <span className="lad-here">{currentLabel}</span>}
                    <div className="lad-choices">{choices}</div>
                  </div>
                ) : (
                  <span className="lad-cell-lock" aria-hidden />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
