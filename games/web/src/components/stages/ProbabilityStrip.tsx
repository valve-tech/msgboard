/**
 * ProbabilityStrip — the flat (no tilt) stage for roll-under/roll-over style games (Dice today;
 * Limbo-family games to follow). Ported verbatim from game-configs.html's `#dice` panel: a header
 * line stating the target, a win/lose bar with a marker pinned at the target, a 0–25–50–75–100
 * scale underneath, and a row of three stat tiles (win chance / multiplier / pays).
 *
 * The bar's win/lose split is derived from `markerPct` itself (not a separate prop) so the green
 * zone always matches "roll under this % to win" — the mockup only ever shows a static 50/50
 * snapshot, but the split has to track the real target to stay truthful.
 */
export const ProbabilityStrip = ({ header, markerPct, stats }: {
  /** e.g. "ROLL UNDER 50.00" — the bold number renders in gold via `.rollhdr b`. */
  header: string
  /** 0–100. Positions `.marker` and the win/lose split along the bar. */
  markerPct: number
  /** The three `.stat` tiles; `gold` renders the value in `.stat.g` gold. */
  stats: { label: string; value: string; gold?: boolean }[]
}) => {
  const pct = Math.min(100, Math.max(0, markerPct))
  // Mockup bolds the trailing number in gold (`ROLL UNDER <b>50.00</b>`) — split it off the same
  // way when the header ends in one, else render the string as-is.
  const words = header.trim().split(' ')
  const lastWord = words[words.length - 1] ?? ''
  const lead = words.slice(0, -1).join(' ')
  const trailingNumber = /^[\d.]+$/.test(lastWord)
  return (
    <div className="dicestage">
      <div className="rollhdr">
        {trailingNumber ? (
          <>
            {lead}{' '}
            <b>{lastWord}</b>
          </>
        ) : (
          header
        )}
      </div>
      <div className="strip">
        {/* .bar's stylesheet background is a static 50/50 green/red split — override it inline so
            the win zone (green) always spans [0, pct] and the loss zone (red) spans [pct, 100],
            matching whatever target the player has actually set. */}
        <div className="bar" style={{ background: `linear-gradient(90deg, var(--green) 0 ${pct}%, #3a1512 ${pct}% 100%)` }}>
          <div className="lose" style={{ left: `${pct}%`, right: 0, width: 'auto' }} />
          <div className="marker" style={{ left: `${pct}%` }} />
        </div>
        <div className="scale">
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100</span>
        </div>
      </div>
      <div className="stats3">
        {stats.map((s) => (
          <div className={s.gold ? 'stat g' : 'stat'} key={s.label}>
            <small>{s.label}</small>
            <b>{s.value}</b>
          </div>
        ))}
      </div>
    </div>
  )
}
