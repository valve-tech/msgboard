import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * NumberBoard — the pick-a-grid surface for the draw games (Keno). A grid of 1..pool cells the player
 * taps to select; after a round the house's draw is revealed cell-by-cell over the same grid so hits
 * (your pick ∩ the draw) light up green, your misses go cold, and the numbers you didn't pick but the
 * house drew show muted.
 *
 * Unlike the other stages this one is INTERACTIVE — `onToggle` picks/unpicks. The reveal is honest:
 * the screen feeds `drawn` recomputed from the round's sealed `raw` (`kenoDraw`, the same set settle
 * counts hits against) and a `drawId` that bumps per round to replay the staggered reveal.
 */
export const NumberBoard = ({
  pool, columns, picks, drawn, onToggle, disabled, capReached, drawId, header, idleHint,
}: {
  pool: number
  columns: number
  /** the player's current selection. */
  picks: number[]
  /** the house draw for the settled round, recomputed from `raw`; undefined before a draw. */
  drawn?: number[]
  onToggle: (n: number) => void
  /** lock the grid (a spin is in flight). */
  disabled?: boolean
  /** at the pick cap — unpicked cells can't be added. */
  capReached?: boolean
  /** bump to replay the staggered draw reveal. */
  drawId: number
  /** status line above the grid (picks/hits/result — supplied by the screen). */
  header?: ReactNode
  /** copy under the grid before the first draw. */
  idleHint?: string
}) => {
  // how many of the drawn numbers have been revealed so far (staggered pop-in).
  const [shown, setShown] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const order = drawn ? [...drawn].sort((a, b) => a - b) : [] // reveal ascending
  const drawIndex = new Map(order.map((n, i) => [n, i]))

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (!drawn || drawn.length === 0) return
    setShown(0)
    const per = Math.max(70, Math.min(140, Math.round(900 / drawn.length)))
    for (let k = 1; k <= drawn.length; k++) timers.current.push(setTimeout(() => setShown(k), per * k))
    return () => timers.current.forEach(clearTimeout)
    // drawId is the trigger; drawn is read fresh each round.
  }, [drawId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickSet = new Set(picks)
  const cells = Array.from({ length: pool }, (_, i) => i + 1)

  return (
    <div className="nb-scene">
      {header && <div className="nb-head">{header}</div>}
      <div className="nb-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }} role="group" aria-label="number grid">
        {cells.map((n) => {
          const picked = pickSet.has(n)
          const live = drawn !== undefined && drawIndex.has(n) && drawIndex.get(n)! < shown
          const cls = live
            ? picked ? 'hit' : 'drew'
            : picked ? (drawn !== undefined ? 'miss' : 'pick') : ''
          return (
            <button
              key={n}
              type="button"
              className={`nb-cell ${cls}`}
              onClick={() => onToggle(n)}
              disabled={disabled || (!picked && capReached)}
              aria-pressed={picked}
            >
              {n}
              {live && <span className="nb-mark" aria-hidden>{picked ? '✦' : '·'}</span>}
            </button>
          )
        })}
      </div>
      {!drawn && idleHint && <div className="nb-hint">{idleHint}</div>}
    </div>
  )
}
