import type { ReactNode } from 'react'

/**
 * The docked control panel for games with NO free stake amount — Hi-Lo War (Hold/Raise), Wordle and
 * Sudoku (ZK puzzles). Shares BetTray's `.bet` container so it sits identically in the `.tray-col`,
 * but drops the amount box: just a titled header, arbitrary control `children`, the primary action,
 * and the provably-fair link. Use BetTray instead whenever the game takes a wager.
 */
export const ControlTray = ({ title = 'Play', hint, action, children }: {
  title?: string
  /** small right-aligned note in the header (e.g. a phase label). */
  hint?: ReactNode
  /** the primary button. */
  action: ReactNode
  children?: ReactNode
}) => (
  <div className="bet">
    <div className="top">
      <span>{title}</span>
      {hint && <span>{hint}</span>}
    </div>
    {children}
    {action}
    <div className="pf-link">🤝 Provably fair — replay the transcript ↗</div>
  </div>
)
