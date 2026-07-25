import { Menu } from './Menu'
import { TRUST_ICON, type TrustModel } from './TrustBanner'

/** The sub-nav shown on every non-lobby screen. Its whole job: never strand a player on a table.
 *  A permanent "🏛 The Floor" button back to the lobby, prev/next through the current game's
 *  category group (so you can move table-to-table without the dropdown), the current table's
 *  name + trust seal so you always know where you are, and the dropdown demoted to a quick-jump. */

export type NavGame = { id: string; label: string }

/** The group each trust model belongs to on the floor — mirrors Lobby's GROUPS titles so the
 *  sub-nav names the same rooms the lobby does. */
const GROUP_TITLE: Record<TrustModel, string> = {
  cosigned: 'House tables',
  p2p: 'Duels',
  zk: 'Proof games',
  validator: 'The numbers',
}

/** "🎲 Greed Dice" → { glyph: "🎲", name: "Greed Dice" } (labels always lead with a glyph). */
const splitLabel = (label: string) => {
  const i = label.indexOf(' ')
  return i > 0 ? { glyph: label.slice(0, i), name: label.slice(i + 1) } : { glyph: '', name: label }
}

export const GameNav = ({
  games,
  tab,
  trustModel,
  trustFor,
  blockNumber,
  onPick,
}: {
  /** The full table list (incl. lobby/standings/live) — the quick-jump menu shows all of them. */
  games: readonly NavGame[]
  tab: string
  /** The active table's trust model, or null for standings/live (no group, no seal). */
  trustModel: TrustModel | null
  trustFor: (id: string) => TrustModel | null
  blockNumber: bigint
  onPick: (id: string) => void
}) => {
  const current = games.find((g) => g.id === tab)
  const { glyph, name } = splitLabel(current?.label ?? tab)

  // The current game's category group, in floor order — the ring prev/next steps through.
  const group = trustModel ? games.filter((g) => trustFor(g.id) === trustModel) : []
  const gi = group.findIndex((g) => g.id === tab)
  const n = group.length
  const prev = n > 1 ? group[(gi - 1 + n) % n]! : undefined
  const next = n > 1 ? group[(gi + 1) % n]! : undefined

  return (
    <nav className="gamenav" aria-label="table navigation">
      <button className="gamenav-floor" onClick={() => onPick('lobby')} title="Back to the lobby">
        🏛 The Floor
      </button>

      {prev && (
        <button
          className="secondary gamenav-step"
          onClick={() => onPick(prev.id)}
          aria-label={`previous table — ${splitLabel(prev.label).name}`}
          title={splitLabel(prev.label).name}
        >
          ‹
        </button>
      )}

      <span className="gamenav-current">
        {trustModel && (
          <span className="gamenav-seal" title={TRUST_ICON[trustModel].title} aria-hidden>
            {TRUST_ICON[trustModel].icon}
          </span>
        )}
        {glyph && (
          <span className="gamenav-glyph" aria-hidden>
            {glyph}
          </span>
        )}
        <span className="gamenav-name">{name}</span>
        {trustModel && GROUP_TITLE[trustModel].toLowerCase() !== name.toLowerCase() && (
          <span className="gamenav-group">· {GROUP_TITLE[trustModel]}</span>
        )}
      </span>

      {next && (
        <button
          className="secondary gamenav-step"
          onClick={() => onPick(next.id)}
          aria-label={`next table — ${splitLabel(next.label).name}`}
          title={splitLabel(next.label).name}
        >
          ›
        </button>
      )}

      <span className="gamenav-right">
        <Menu
          label="jump to a table"
          options={games.map((g) => {
            const m = trustFor(g.id)
            return {
              label: g.label,
              badge: m ? TRUST_ICON[m].icon : undefined,
              badgeTitle: m ? TRUST_ICON[m].title : undefined,
            }
          })}
          value={Math.max(0, games.findIndex((g) => g.id === tab))}
          onChange={(i) => onPick(games[i]!.id)}
        />
        <span className="blockline">block {blockNumber.toString()}</span>
      </span>
    </nav>
  )
}
