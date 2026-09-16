import type { ReactNode } from 'react'

/**
 * CanvasStage — the flat (no tilt) canvas surface for line/curve games (Crash today). Ported
 * verbatim from game-configs.html's `#crash` panel: a faint background grid, an optional SVG
 * curve, the big glowing multiplier readout, and a history rail of past-round chips. Depth comes
 * from glow/shadow only — unlike FeltTable there's no perspective plane.
 */
export const CanvasStage = ({ multiplier, curve, history }: {
  /** The big glowing multiplier readout (`.mult`). */
  multiplier: ReactNode
  /** The SVG curve/path (`.curve`) — decorative table furniture; omit if there's no curve to draw. */
  curve?: ReactNode
  /** Past-round multiplier chips rail (`.hist`). */
  history?: ReactNode
}) => (
  <div className="crashstage">
    <div className="grid" />
    {curve}
    <div className="mult">{multiplier}</div>
    {history && <div className="hist">{history}</div>}
  </div>
)
