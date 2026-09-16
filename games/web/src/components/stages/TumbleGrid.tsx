import { useEffect, useRef, useState } from 'react'

/**
 * TumbleGrid — the tumbling-slot stage for the cascade games (Cascade / "Gates of Olympus"-style). A
 * COLS×ROWS grid of symbols where any symbol present enough times pays and clears, survivors fall, and
 * fresh symbols drop in — repeating until a fill produces no win. The total multiplier is the sum of
 * every tumble's pay.
 *
 * The animation is NOT decoration: a screen feeds the exact `steps` the settlement produced (each the
 * real pre-removal grid + the cells that clear + that tumble's pay) recomputed from the round's sealed
 * `raw`, plus the `finalGrid` left standing. This surface only sequences them — it holds each paying
 * grid with the winning cells glowing, then advances to the next step's grid (already fallen + refilled
 * in the data), so what the player watches is precisely what the co-signed multiplier was built from.
 *
 * Game-agnostic: a screen supplies `cols`/`rows`, the `symbols` glyph table, the `steps`, the
 * `finalGrid`, the `totalX100`, whether the round `won`, and a `tumbleId` that re-triggers playback.
 */
export type TumbleStep = {
  /** the grid (length cols*rows, index = row*cols + col, row 0 = top) BEFORE this tumble's removals. */
  grid: number[]
  /** the cells cleared this tumble (true = matched & paid), aligned to `grid`. */
  removed: boolean[]
  /** the pay (×100 of the bet) awarded this tumble. */
  payX100: bigint
}

const STEP_MS = 760 // how long each paying grid is held (glow → clear) before the next frame
const fx = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

export const TumbleGrid = ({ cols, symbols, steps, finalGrid, totalX100, won, tumbleId, idleHint }: {
  cols: number
  /** glyphs indexed by symbol id (0..symbols.length-1), ascending pay. */
  symbols: readonly string[]
  /** the paying tumbles in order; empty when the round never matched. */
  steps: TumbleStep[]
  /** the grid left standing after the final (non-paying) fill. */
  finalGrid: number[]
  /** total round multiplier (×100). */
  totalX100: bigint
  /** did the round come out ahead (total ≥ 1x)? colours the settled readout. */
  won: boolean
  /** bump to (re)play the tumble for the latest round. */
  tumbleId: number
  /** copy shown before the first spin. */
  idleHint?: string
}) => {
  // which tumble we're showing; frame === steps.length means settled (showing finalGrid).
  const [frame, setFrame] = useState(0)
  const [armed, setArmed] = useState(false) // a round has been played this mount
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (tumbleId <= 0) return
    setArmed(true)
    setFrame(0)
    let k = 0
    const tick = () => {
      k += 1
      setFrame(k)
      if (k < steps.length) timers.current.push(setTimeout(tick, STEP_MS))
    }
    if (steps.length > 0) timers.current.push(setTimeout(tick, STEP_MS))
    return () => timers.current.forEach(clearTimeout)
    // tumbleId is the trigger; steps/finalGrid are read fresh for each round.
  }, [tumbleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const settled = !armed || frame >= steps.length
  const step = !settled ? steps[frame] : undefined
  const grid = step ? step.grid : finalGrid
  const running = steps.slice(0, frame).reduce((a, s) => a + s.payX100, 0n)

  return (
    <div className="tg-scene">
      <div className="tg-head">
        {!armed ? (
          <span className="muted">{idleHint ?? 'spin to tumble'}</span>
        ) : step ? (
          <>
            <span>tumble <b>{frame + 1}</b>/<b>{steps.length}</b></span>
            <span className="muted">paid</span> <b className="ok">{fx(step.payX100)}</b>
            <span className="muted">· running</span> <b>{fx(running)}</b>
          </>
        ) : (
          <>
            <span><b>{steps.length}</b> tumble{steps.length === 1 ? '' : 's'}</span>
            <span className="muted">· total</span>
            <b className={won ? 'ok' : 'bad'}>{fx(totalX100)}</b>
          </>
        )}
      </div>
      {/* key on frame so each real post-tumble grid re-mounts and plays the fall-in animation. */}
      <div className="tg-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} key={frame}>
        {grid.map((s, i) => (
          <span
            key={i}
            className={`tg-cell${step?.removed[i] ? ' win' : ''}`}
            style={{ animationDelay: `${(Math.floor(i / cols)) * 26}ms` }}
            aria-hidden
          >
            {symbols[s]}
          </span>
        ))}
      </div>
    </div>
  )
}
