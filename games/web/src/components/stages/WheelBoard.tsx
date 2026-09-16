import { useMemo } from 'react'
import { isRed } from '@msgboard/games'

/**
 * WheelBoard — the tilted single-zero wheel + flat full 0–36 betting board for Roulette. Ported
 * verbatim from the approved roulette-v2.html mockup: the wheel is a disc (`rotateX` tilt, from
 * table.css) whose `.pockets` ring is a conic-gradient built from the real European sequence; the
 * board is flat and head-on so every number stays legible/tappable.
 *
 * Reds are sourced from `@msgboard/games`' `isRed` (mirrors `RED_MASK` in roulette.ts) so the board
 * and wheel can never drift from the settlement module's red/black split — there is no hand-copied
 * color list here.
 *
 * The wheel's physical pocket ORDER below is purely cosmetic (the conic-gradient ring layout);
 * settlement is `raw % 37` and does not depend on where a number sits on the wheel.
 */
const WHEEL_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
  7, 28, 12, 35, 3, 26,
] as const

const pocketHex = (n: number): string => (n === 0 ? '#1c6644' : isRed(n) ? '#c0392b' : '#141414')

interface BoardCell {
  n: number
  cls: 'r' | 'b' | 'g'
  gridColumn: number
  gridRow: number
}

/** bet identifiers handed to `onCell` — the caller maps these onto whichever real bet types/selections
 *  it can actually settle; WheelBoard itself holds no bet/settlement state. */
export type RouletteCellBet =
  | `straight:${number}`
  | `dozen:${0 | 1 | 2}`
  | `column:${0 | 1 | 2}`
  | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high'

export const WheelBoard = ({
  recent,
  onCell,
}: {
  /** recent spun pockets, most-recent last. */
  recent: { n: number; color: 'r' | 'b' | 'g' }[]
  /** optional — fires with a bet identifier when a board zone is clicked; the board itself is stateless. */
  onCell?: (bet: RouletteCellBet) => void
}) => {
  const pocketsGradient = useMemo(() => {
    const step = 360 / WHEEL_SEQUENCE.length
    const stops = WHEEL_SEQUENCE.map(
      (n, i) => `${pocketHex(n)} ${(i * step).toFixed(2)}deg ${((i + 1) * step).toFixed(2)}deg`,
    )
    return `conic-gradient(${stops.join(',')})`
  }, [])

  // 0 spans the left column via the `.cell.g` CSS rule (grid-row:1/span 3;grid-column:1) — no inline
  // placement needed for it. 1..36 are placed by the same formula as the mockup's script.
  const numberCells = useMemo<BoardCell[]>(() => {
    const cells: BoardCell[] = [{ n: 0, cls: 'g', gridColumn: 1, gridRow: 1 }]
    for (let n = 1; n <= 36; n++) {
      cells.push({ n, cls: isRed(n) ? 'r' : 'b', gridColumn: Math.ceil(n / 3) + 1, gridRow: 3 - ((n - 1) % 3) })
    }
    return cells
  }, [])

  // the three "2:1" column cells: board row 1 holds multiples of 3 (column selection 2), row 2 holds
  // n%3===2 (selection 1), row 3 holds n%3===1 (selection 0) — see gridRow formula above.
  const col21Selection = (row: number): 0 | 1 | 2 => (row === 1 ? 2 : row === 2 ? 1 : 0)

  return (
    <div className="roulstage">
      <div className="wheelrow">
        <div className="wheelwrap">
          <div className="wheel">
            <div className="pockets" style={{ background: pocketsGradient }} />
            <div className="ball" />
            <div className="hub" />
          </div>
        </div>
        <div className="recent">
          <span className="rlabel">Recent numbers</span>
          <div className="nums">
            {recent.slice(-6).map((r, i) => (
              <span key={i} className={`num ${r.color}`}>{r.n}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="boardwrap">
        <span className="felt-note">flat board — numbers stay readable &amp; tappable</span>
        <div className="grid">
          {numberCells.map((c) => (
            <div
              key={c.n}
              className={`cell ${c.cls}`}
              style={c.n === 0 ? undefined : { gridColumn: c.gridColumn, gridRow: c.gridRow }}
              onClick={onCell ? () => onCell(`straight:${c.n}`) : undefined}
            >
              {c.n}
            </div>
          ))}
          {([1, 2, 3] as const).map((row) => (
            <div
              key={`col21-${row}`}
              className="cell col21"
              style={{ gridColumn: 14, gridRow: row }}
              onClick={onCell ? () => onCell(`column:${col21Selection(row)}`) : undefined}
            >
              2:1
            </div>
          ))}
        </div>
        <div className="dozens">
          <div className="lead" />
          <div onClick={onCell ? () => onCell('dozen:0') : undefined}>1ST 12</div>
          <div onClick={onCell ? () => onCell('dozen:1') : undefined}>2ND 12</div>
          <div onClick={onCell ? () => onCell('dozen:2') : undefined}>3RD 12</div>
          <div />
        </div>
        <div className="outside">
          <div className="lead" />
          <div onClick={onCell ? () => onCell('low') : undefined}>1–18</div>
          <div onClick={onCell ? () => onCell('even') : undefined}>EVEN</div>
          <div className="red" onClick={onCell ? () => onCell('red') : undefined}>RED</div>
          <div onClick={onCell ? () => onCell('black') : undefined}>BLACK</div>
          <div onClick={onCell ? () => onCell('odd') : undefined}>ODD</div>
          <div onClick={onCell ? () => onCell('high') : undefined}>19–36</div>
          <div />
        </div>
      </div>
    </div>
  )
}
