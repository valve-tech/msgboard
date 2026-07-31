import { useState, type ReactNode } from 'react'

/**
 * FeltTable — the tilted felt-table stage for seated card games. A raked plane (`.plane`, rotateX)
 * sits a wood `.rail-ring` and green `.felt` in a seated perspective. Two hand slots read at
 * different depths: `dealer` at the far end (on the tilted plane) and `player` standing up big and
 * close in the foreground (`.hand`, outside the plane so it reads flat). `spots` are the betting
 * circles near the front edge; `spread` is an optional centered row for games whose hands sit
 * side-by-side rather than dealer-vs-foreground.
 *
 * CAMERA: a small switcher moves the vantage point like a video game — Seat (the default seated
 * rake), Aerial (lean over the table, flatter, the whole layout visible at once — handy when both
 * sides show hands, e.g. Pai Gow's front/back split), Rail (low and close, leaning in to study your
 * cards), and 2D (a flat straight-down layout, the way an online roulette table reads). It only
 * re-aims the CSS perspective + plane tilt; no game state is touched. Pass `views={false}` to pin a
 * table to the seated view.
 *
 * Furniture (chip rack, shoe) is decorative — no game state. Real game data flows only through the
 * `dealer` / `player` / `spread` / `spots` slots; `arc` (felt caption) and `centerMark` (the medal)
 * are per-table copy the screen supplies.
 */
const VIEWS = [
  { key: 'seat', label: 'Seat' },
  { key: 'aerial', label: 'Aerial' },
  { key: 'rail', label: 'Rail' },
  { key: 'flat', label: '2D' },
] as const
type FeltView = (typeof VIEWS)[number]['key']

export const FeltTable = ({ dealer, player, spots, spread, arc, centerMark, views = true }: {
  /** Far-end hand — dealer's up/hole cards, or in a duel the house/Banker hand. On the tilted plane. */
  dealer?: ReactNode
  /** Foreground hand — rendered in `.hand`, outside the tilted plane (flat + large). */
  player?: ReactNode
  /** Betting circle(s) near the felt's front edge. */
  spots?: ReactNode
  /** Optional centered row on the felt for side-by-side layouts (e.g. Dragon | Tiger). */
  spread?: ReactNode
  /** Curved caption printed on the felt (e.g. "PLAYER 1:1 · BANKER 0.95 · TIE 8"). Omit for none. */
  arc?: ReactNode
  /** The center-of-felt mark. Defaults to the house "M" medal; pass a node to override, `null` to hide. */
  centerMark?: ReactNode
  /** Show the camera-view switcher (Seat/Aerial/Rail). Default true; `false` pins the seated view. */
  views?: boolean
}) => {
  const [view, setView] = useState<FeltView>('seat')
  return (
    <div className={`scene view-${view}`}>
      {views && (
        <div className="felt-views" role="group" aria-label="camera view">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" className={v.key === view ? 'on' : ''} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="plane">
        <div className="rail-ring">
          <div className="felt">
            <div className="drack">
              <span className="chip" style={{ background: '#d05a4e' }} />
              <span className="chip" style={{ background: '#4a7fd0' }} />
              <span className="chip" style={{ background: '#2fae6a' }} />
              <span className="chip" style={{ background: '#8a6bd0' }} />
              <span className="chip" style={{ background: '#c9a227' }} />
            </div>
            <div className="shoe" />
            {dealer && (
              <div style={{ position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)' }}>
                {dealer}
              </div>
            )}
            {spread && (
              <div style={{ position: 'absolute', top: '44%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                {spread}
              </div>
            )}
            {arc && <div className="arc">{arc}</div>}
            {centerMark === undefined ? <div className="medal">M</div> : centerMark && <div className="medal">{centerMark}</div>}
            {/* On the raked plane the bet circles sit at the felt's front edge — Seat's perspective
                widens the foreground so they clear the cloth. The flatter/zoomed cameras lose that
                widening, so here they only ride the plane in Seat; 2D gets a flat strip instead. */}
            {spots && view === 'seat' && <div className="spots">{spots}</div>}
          </div>
        </div>
      </div>
      {player && <div className="hand">{player}</div>}
      {/* Flat 2D betting layout: the same bet spots laid out in clean screen space (outside the 3D
          plane, like a roulette table's layout) so nothing mis-projects or clips. 2D view only. */}
      {spots && view === 'flat' && <div className="spots-flat">{spots}</div>}
    </div>
  )
}
