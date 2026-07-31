import { useEffect, useRef, useState } from 'react'

/**
 * DropBoard — the peg-field stage for the ball-drop games (Plinko, Pachinko). A triangular Galton
 * lattice of pegs sits above a row of payout buckets; a ball descends peg-to-peg into a bucket.
 *
 * The descent is NOT decorative: each screen feeds the committed `path` (one bit per row, 0 = left /
 * 1 = right) recomputed from the round's sealed `raw`, so the ball visibly walks the exact deflections
 * that set the payout — the same bits the settle counts. The lattice is game-agnostic; a screen supplies
 * `rows`, the per-bucket `buckets` (label + payout tier), and a `dropId` that re-triggers the animation.
 *
 * Geometry: position runs on a 0..rows axis. The ball starts centered (rows/2) and each deflection
 * shifts it ±0.5, so after `rows` steps it rests at integer `bucket` = count of rights — exactly the
 * package's `plinkoBucket`. Pegs at deflection-level r are the r+1 lattice points the ball can occupy,
 * so it always touches a peg before it bounces.
 */
export type DropBucket = { mult: string; tier: 'lo' | 'mid' | 'hi' }

const TOP_PAD = 6 // %: y of the first peg row / parked ball
const PEG_SPAN = 64 // %: vertical extent of the peg field
const BUCKET_Y = 90 // %: resting y once the ball drops into a bucket
const STEP_MS = 110 // per-row descent time; the ball's CSS transition matches

export const DropBoard = ({ rows, buckets, path, dropId, idleHint }: {
  rows: number
  /** payout slots, length rows+1, left→right. */
  buckets: DropBucket[]
  /** the committed deflections (length rows, 0/1) recomputed from `raw`; undefined until a drop lands. */
  path?: number[]
  /** bump to (re)play the descent for the latest drop. */
  dropId: number
  /** copy shown before the first drop. */
  idleHint?: string
}) => {
  // how many deflections have been applied to the ball so far (0..rows), then `settled` in the bucket.
  const [step, setStep] = useState(0)
  const [settled, setSettled] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (!path || path.length === 0) return
    setSettled(false)
    setStep(0)
    let k = 0
    const tick = () => {
      k += 1
      setStep(k)
      timers.current.push(setTimeout(k < rows ? tick : () => setSettled(true), STEP_MS))
    }
    timers.current.push(setTimeout(tick, STEP_MS))
    return () => timers.current.forEach(clearTimeout)
    // dropId is the trigger; path/rows are read fresh each drop.
  }, [dropId]) // eslint-disable-line react-hooks/exhaustive-deps

  const dropped = path !== undefined && path.length > 0
  const bucket = dropped ? path!.reduce((n, b) => n + b, 0) : undefined // rights = landing bucket

  // ball position on the 0..rows axis → left %, plus the descending top %.
  let pos = rows / 2
  if (dropped) for (let i = 0; i < step; i++) pos += path![i] ? 0.5 : -0.5
  const leftPct = (pos / rows) * 100
  const topPct = settled ? BUCKET_Y : TOP_PAD + ((dropped ? step : 0) / rows) * PEG_SPAN

  const pegs: { x: number; y: number }[] = []
  for (let r = 0; r < rows; r++) {
    const y = TOP_PAD + (r / rows) * PEG_SPAN
    for (let j = 0; j <= r; j++) pegs.push({ x: ((rows - r) / 2 + j) / rows, y })
  }

  return (
    <div className="drop-scene">
      <div className="drop-plot">
        {pegs.map((p, i) => (
          <span key={i} className="drop-peg" style={{ left: `${p.x * 100}%`, top: `${p.y}%` }} aria-hidden />
        ))}
        <span
          className={`drop-ball${dropped ? ' live' : ''}${settled ? ' settled' : ''}`}
          style={{ left: `${leftPct}%`, top: `${topPct}%`, transition: `top ${STEP_MS}ms linear, left ${STEP_MS}ms ease-in-out` }}
          aria-hidden
        />
        <div className="drop-buckets">
          {buckets.map((b, i) => (
            <span
              key={i}
              className={`drop-bucket ${b.tier}${settled && bucket === i ? ' hit' : ''}`}
              style={{ left: `${(i / rows) * 100}%` }}
            >
              {b.mult}
            </span>
          ))}
        </div>
      </div>
      {!dropped && idleHint && <div className="drop-hint">{idleHint}</div>}
    </div>
  )
}
