import type { ReactNode } from 'react'

/** One rendered tile: hidden (untapped), a revealed safe gem, or the revealed bust mine. */
export type RevealTile = { state: 'hidden' | 'gem' | 'bomb' }

/**
 * RevealGrid — the flat tap-grid stage for Mines. Ported verbatim from game-configs.html's `#mines`
 * panel: a `.minesstage` wrapper holding an optional `.mnext` pill (next-tile / cash-out multiplier)
 * over a `.mgrid` of `.tile` cells, each styled `.gem`/`.bomb`/(default hidden) by `table.css`.
 *
 * Stateless and game-agnostic: `tiles` is the full board (already mapped from whatever session
 * shape the caller uses), `cols` drives the CSS grid column count, and `onTile` fires with the
 * tapped tile's index so the caller can route it into its own reveal handler (which decides
 * whether the tap is actually allowed — this component does not gate taps itself).
 */
export const RevealGrid = ({ cols, tiles, banner, onTile }: {
  cols: number
  tiles: RevealTile[]
  banner?: ReactNode
  onTile?: (i: number) => void
}) => (
  <div className="minesstage">
    {banner && <div className="mnext">{banner}</div>}
    <div className="mgrid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {tiles.map((t, i) => (
        <div
          key={i}
          className={`tile${t.state === 'hidden' ? ' hidden' : t.state === 'gem' ? ' gem' : ' bomb'}`}
          onClick={() => onTile?.(i)}
          role="button"
          aria-label={`tile ${i}${t.state === 'hidden' ? '' : t.state === 'gem' ? ' safe' : ' mine'}`}
        >
          {t.state === 'gem' ? '💎' : t.state === 'bomb' ? '💣' : ''}
        </div>
      ))}
    </div>
  </div>
)
