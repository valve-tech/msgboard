import { useEffect, useState } from 'react'

/**
 * PoolLedger — the surface for a stake-weighted pari-mutuel pool (Lottery). Every entrant wagers a
 * continuous stake into ONE pool; a single sealed draw picks a winning POINT in [0, totalStake), and
 * whoever's cumulative-stake segment contains that point wins the pool. So the honest picture is a
 * single bar carved into one segment per entrant (width = their share of the pool = their exact odds),
 * with a marker that lands on the winning segment.
 *
 * The marker is NOT decoration: a screen feeds the real `winningPoint` the draw produced (recomputed
 * from the sealed seed + the final entry list), and the marker lands at winningPoint / pool — the same
 * ratio `ownerAtPoint` walks to name the winner. It sweeps in from the left to that real position, then
 * the containing segment lights up. Before the draw the bar simply grows as entrants buy in, each seat's
 * width tracking its live share.
 *
 * Game-agnostic: a screen supplies the `seats` (label + stake + whose is mine), the `pool` total, the
 * `winningPoint` once drawn, a `drawId` that re-triggers the sweep, and a `fmt` for the amounts.
 */
export type PoolSeat = { key: string; label: string; sub?: string; stake: bigint; mine?: boolean }

const HUES = ['#3aa76a', '#4a7fd0', '#b8413a', '#8a5cc9', '#c98a27', '#2fae6a', '#4a9fd0', '#c96a8a']
const SWEEP_MS = 1150
const seatHue = (seat: PoolSeat, i: number): string => (seat.mine ? '#f0c74a' : HUES[i % HUES.length]!)
/** point ÷ pool as a percent with 3 decimals, done in bigint to keep precision on large wei values. */
const pctOf = (part: bigint, whole: bigint): number => (whole <= 0n ? 0 : Number((part * 100000n) / whole) / 1000)

export const PoolLedger = ({ seats, pool, winningPoint, drawId, fmt, unit = 'PLS', idleHint }: {
  seats: PoolSeat[]
  /** total wei wagered across all seats. */
  pool: bigint
  /** the sealed winning point in [0, pool); undefined until the draw. */
  winningPoint?: bigint
  /** bump to (re)play the marker sweep for the latest draw. */
  drawId: number
  /** format a wei amount for display. */
  fmt: (wei: bigint) => string
  unit?: string
  /** copy shown before anyone has entered. */
  idleHint?: string
}) => {
  const [markerLeft, setMarkerLeft] = useState<number | null>(null)
  const [landed, setLanded] = useState(false)

  useEffect(() => {
    if (drawId <= 0 || winningPoint === undefined || pool <= 0n) {
      setMarkerLeft(null)
      setLanded(false)
      return
    }
    const target = pctOf(winningPoint, pool)
    setLanded(false)
    setMarkerLeft(0)
    const t1 = setTimeout(() => setMarkerLeft(target), 40)
    const t2 = setTimeout(() => setLanded(true), 40 + SWEEP_MS)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
    // drawId is the trigger; winningPoint/pool are read fresh for each draw.
  }, [drawId]) // eslint-disable-line react-hooks/exhaustive-deps

  // cumulative offsets → the winning seat index (the segment [before, before+stake) holding the point).
  let cum = 0n
  const segs = seats.map((seat, i) => {
    const before = cum
    cum += seat.stake
    const isWinner =
      winningPoint !== undefined && winningPoint >= before && winningPoint < cum
    return { seat, i, before, leftPct: pctOf(before, pool), widthPct: pctOf(seat.stake, pool), isWinner }
  })
  const empty = seats.length === 0 || pool <= 0n

  return (
    <div className="pool-scene">
      <div className="pool-head">
        <span className="pool-pot">
          <span className="muted">pool</span> <b>{fmt(pool)}</b> <span className="muted">{unit}</span>
        </span>
        <span className="muted">· {seats.length} entr{seats.length === 1 ? 'y' : 'ies'}</span>
      </div>

      {empty ? (
        <div className="pool-empty">{idleHint ?? 'enter the pool to open the draw'}</div>
      ) : (
        <>
          <div className="pool-bar">
            {segs.map(({ seat, i, leftPct, widthPct, isWinner }) => (
              <span
                key={seat.key}
                className={`pool-seg${seat.mine ? ' mine' : ''}${landed && isWinner ? ' won' : ''}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: seatHue(seat, i) }}
                title={`${seat.label} · ${fmt(seat.stake)} ${unit}`}
                aria-hidden
              />
            ))}
            {markerLeft !== null && (
              <span
                className={`pool-marker${landed ? ' landed' : ''}`}
                style={{ left: `${markerLeft}%`, transition: `left ${SWEEP_MS}ms cubic-bezier(.15,.85,.25,1)` }}
                aria-hidden
              />
            )}
          </div>

          <div className="pool-ledger">
            {segs.map(({ seat, i, widthPct, isWinner }) => (
              <div key={seat.key} className={`pool-row${seat.mine ? ' mine' : ''}${landed && isWinner ? ' won' : ''}`}>
                <span className="pool-swatch" style={{ background: seatHue(seat, i) }} aria-hidden />
                <span className="pool-name">
                  {seat.label}
                  {seat.sub && <span className="pool-sub">{seat.sub}</span>}
                  {landed && isWinner && <span className="pool-badge">🏆 winner</span>}
                </span>
                <span className="pool-odds">{widthPct.toFixed(1)}%</span>
                <span className="pool-stake">{fmt(seat.stake)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
