import type { ReactNode } from 'react'

/**
 * FeltTable — the tilted felt-table stage for seated card games (Blackjack today; Baccarat/Poker-
 * family games to follow). Ported verbatim from the approved table-feel-v2.html mockup: a raked
 * plane (`.plane`, rotateX) sits a wood `.rail-ring` and green `.felt` in a seated perspective, with
 * the dealer's cards + betting circles at the far end and the player's hand standing up big and
 * close in the foreground (`.hand`, outside the tilted plane so it reads flat).
 *
 * The chip rack / shoe / arc copy / medal mark are decorative table furniture straight from the
 * mockup — no game state. `dealer`, `player` and `spots` are the only slots real game data flows
 * through.
 */
export const FeltTable = ({ dealer, player, spots }: {
  /** Far-end cards (dealer's up-card/hole-card, or the settled dealer hand). */
  dealer: ReactNode
  /** The foreground hand — rendered in `.hand`, outside the tilted plane. */
  player: ReactNode
  /** Betting circle(s) near the felt's front edge. */
  spots?: ReactNode
}) => (
  <div className="scene">
    <div className="plane">
      <div className="rail-ring">
        <div className="felt">
          <div className="drack">
            <span className="chip" style={{ background: '#d05a4e' }} />
            <span className="chip" style={{ background: '#4a7fd0' }} />
            <span className="chip" style={{ background: '#2fae6a' }} />
            <span className="chip" style={{ background: '#8a6bd0' }} />
            <span className="chip" style={{ background: '#e8b93f' }} />
          </div>
          <div className="shoe" />
          <div style={{ position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)' }}>
            {dealer}
          </div>
          <div className="arc">BLACKJACK PAYS 3 TO 2 · INSURANCE PAYS 2 TO 1</div>
          <div className="medal">M</div>
          {spots && <div className="spots">{spots}</div>}
        </div>
      </div>
    </div>
    <div className="hand">{player}</div>
  </div>
)
