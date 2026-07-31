import { useState, type ReactNode } from 'react'

/**
 * BookBoard — the offer-book surface for the P2P market games (FlipBook, FlipBookX). These aren't
 * house games: makers post escrowed/signed coin-flip offers, takers call the coin, and each side
 * reveals within a deadline. So the "stage" is a live ledger, not a single-round visual.
 *
 * Three moving parts, in priority order:
 *   1. `alert` — money-critical notices (a reveal due, funds owed) pinned above everything and never
 *      scrolled away, because missing a reveal window forfeits real stake + bond.
 *   2. tabbed lanes — the offers grouped by lifecycle (Open · In flight · Settled) with live counts.
 *   3. the active lane — a scrolling column of offer rows the screen supplies verbatim.
 *
 * Purely presentational: every offer row, action button, countdown and on-chain handler lives in the
 * screen. This owns only the frame + which lane is showing.
 */
export const BookBoard = ({ alert, lanes, defaultKey, empty }: {
  /** pinned money-critical banners (reveal due, owed) — always visible above the lanes. */
  alert?: ReactNode
  /** lifecycle lanes, in tab order; each supplies its own rows as `node`. */
  lanes: { key: string; label: string; count: number; node: ReactNode }[]
  /** which lane opens first (e.g. jump to "In flight" when a reveal is due). */
  defaultKey?: string
  /** copy for an empty lane. */
  empty?: ReactNode
}) => {
  const [active, setActive] = useState(defaultKey ?? lanes[0]?.key)
  const lane = lanes.find((l) => l.key === active) ?? lanes[0]
  return (
    <div className="bk-scene">
      {alert && <div className="bk-alert">{alert}</div>}
      <div className="bk-book">
        <div className="bk-tabs" role="tablist">
          {lanes.map((l) => (
            <button
              key={l.key}
              type="button"
              role="tab"
              aria-selected={l.key === lane?.key}
              className={`bk-tab${l.key === lane?.key ? ' on' : ''}`}
              onClick={() => setActive(l.key)}
            >
              {l.label}
              <span className="bk-count">{l.count}</span>
            </button>
          ))}
        </div>
        <div className="bk-lane">
          {lane && lane.count > 0 ? lane.node : <div className="bk-empty">{empty ?? 'nothing here yet'}</div>}
        </div>
      </div>
    </div>
  )
}
