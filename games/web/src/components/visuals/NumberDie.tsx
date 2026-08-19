import { useReveal } from './reveal'

/**
 * NumberDie — the Clean-2D die for the roll-under family (Dice today; Dice X2, Limbo to follow).
 *
 * A rounded brass tile whose number flurries, then lands on the sealed roll. Below it, a landing
 * track shows the win zone (green, up to the target) and drops a marker where the roll fell — so the
 * player sees WHY they won or lost, not just a number. Win/lose colour comes from the settled
 * record's `win` flag, never recomputed here.
 *
 * The die is display only. It reads the outcome the session already sealed; it never rolls anything.
 */
export const NumberDie = ({
  outcome,
  target,
  win,
  revealNonce,
}: {
  /** The rolled value as a percent, 0.00–99.99. `undefined` before the first roll. */
  outcome?: number
  /** The roll-under target as a percent. The player wins when the roll lands below it. */
  target: number
  /** The settled win flag from the co-signed record. `undefined` before the first roll. */
  win?: boolean
  /** Changes each round (the round number) so a new roll replays the flurry. */
  revealNonce?: unknown
}) => {
  const { value, flurrying } = useReveal(outcome, { nonce: revealNonce })
  const has = value !== undefined
  const settled = has && !flurrying

  // Tile state drives colour: neutral while idle or spinning, green/red once the record says so.
  const state = flurrying ? 'rolling' : win === undefined || !has ? 'idle' : win ? 'win' : 'lose'
  const shown = has ? value.toFixed(2) : '00.00'

  const clampPct = (n: number) => Math.min(100, Math.max(0, n))
  const targetPct = clampPct(target)
  // The marker sits at the roll along the 0–100 track; while flurrying it tracks the frame value.
  const markerPct = has ? clampPct(value) : targetPct

  return (
    <div className="dicevis">
      <div
        className={`ndie ndie-${state}`}
        aria-live="polite"
        aria-label={settled ? `rolled ${shown} percent, ${win ? 'win' : 'lose'}` : undefined}
      >
        <span className="ndie-num">{shown}</span>
        <span className="ndie-unit">%</span>
      </div>

      {/* Landing track: green win zone [0, target], red loss zone after it, marker at the roll. */}
      <div className="ndie-track" aria-hidden>
        <div
          className="ndie-bar"
          style={{ background: `linear-gradient(90deg, var(--green) 0 ${targetPct}%, #3a1512 ${targetPct}% 100%)` }}
        >
          <div className={`ndie-marker${flurrying ? ' live' : ''}`} style={{ left: `${markerPct}%` }} />
        </div>
        <div className="ndie-scale">
          <span>0</span>
          <span>{targetPct.toFixed(0)}</span>
          <span>100</span>
        </div>
      </div>

      <div className="ndie-verdict">
        {!has ? (
          <span className="muted">roll to reveal · win under {target.toFixed(2)}%</span>
        ) : flurrying ? (
          <span className="muted">rolling…</span>
        ) : (
          <span>
            <b className="ndie-verdict-roll">{shown}</b>
            <span className="muted"> · needed under {target.toFixed(2)}% · </span>
            <b className={win ? 'ok' : 'bad'}>{win ? 'WIN' : 'LOSE'}</b>
          </span>
        )}
      </div>
    </div>
  )
}
