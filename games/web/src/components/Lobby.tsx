import { useEffect, useMemo, useState } from 'react'
import type { GameDeployment } from '../config'

/**
 * The landing floor — the first thing a visitor sees. The design thesis: our answer to the
 * neon-arcade casinos is the old-money card room that SHOWS ITS BOOKS. So the hero is the
 * house's promise set in the letterhead serif, the signature element is the receipt rail —
 * REAL settle events off the indexer ticking past like engraved slips (their theatre is
 * faked; our ornament is the actual ledger) — and every felt tile on the floor carries the
 * seal of the trust model it rests on.
 */

type TrustModel = 'validator' | 'p2p' | 'zk' | 'cosigned'

export type LobbyGame = { id: string; label: string }

const SEAL: Record<TrustModel, { icon: string; title: string }> = {
  cosigned: { icon: '✓', title: 'Seed sealed before the first hand; your browser recomputes every payout' },
  p2p: { icon: '🤝', title: 'Peer vs peer — no house randomness at all' },
  zk: { icon: '🔮', title: 'Zero-knowledge proof — trust only the math' },
  validator: { icon: '⛓', title: 'Seed drawn from validator secrets locked on chain' },
}

const GROUPS: { key: TrustModel; title: string; blurb: string }[] = [
  { key: 'cosigned', title: 'House tables', blurb: 'seed sealed before you bet · settle recomputed in your browser' },
  { key: 'p2p', title: 'Duels', blurb: 'player against player · the house holds nothing' },
  { key: 'zk', title: 'Proof games', blurb: 'skill, attested by zero-knowledge proof' },
  { key: 'validator', title: 'The numbers', blurb: 'drawn from validator secrets on chain' },
]

type Receipt = { game: string; name: string; block: string }

/** Last few terminal events off the games indexer — the rail's raw material. Fails to empty. */
const useReceipts = (indexer: string | undefined, chainId: number): Receipt[] => {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  useEffect(() => {
    if (!indexer) return
    let stop = false
    const load = async () => {
      try {
        const res = await fetch(indexer, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `query($chainId: Int!) { gameEvents(where: { chainId: $chainId }, orderBy: "blockNumber", orderDirection: "desc", limit: 14) { items { game name blockNumber } } }`,
            variables: { chainId },
          }),
        })
        const json = (await res.json()) as {
          data?: { gameEvents?: { items?: { game: string; name: string; blockNumber: string }[] } }
        }
        const items = json.data?.gameEvents?.items ?? []
        if (!stop) setReceipts(items.map((e) => ({ game: e.game, name: e.name, block: e.blockNumber })))
      } catch {
        /* the rail simply stays empty — the floor never breaks over decoration */
      }
    }
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [indexer, chainId])
  return receipts
}

/** "🎲 Greed Dice" -> { glyph: "🎲", name: "Greed Dice" } (labels always lead with the glyph). */
const splitLabel = (label: string) => {
  const i = label.indexOf(' ')
  return i > 0 ? { glyph: label.slice(0, i), name: label.slice(i + 1) } : { glyph: '', name: label }
}

export const Lobby = ({
  deployment,
  games,
  trustFor,
  onPick,
}: {
  deployment: GameDeployment
  games: LobbyGame[]
  trustFor: (id: string) => TrustModel | null
  onPick: (id: string) => void
}) => {
  const receipts = useReceipts(deployment.gamesIndexer, deployment.chainId)
  const grouped = useMemo(() => {
    const byModel = new Map<TrustModel, LobbyGame[]>()
    for (const g of games) {
      const model = trustFor(g.id)
      if (!model) continue
      const list = byModel.get(model) ?? []
      list.push(g)
      byModel.set(model, list)
    }
    return byModel
  }, [games, trustFor])
  const tableCount = games.filter((g) => trustFor(g.id) !== null).length

  return (
    <div className="lobby">
      <section className="lobby-hero">
        <div className="lobby-eyebrow mono">
          {deployment.label} · every table verifiable · no account, just a wallet
        </div>
        <h2 className="lobby-headline">
          The house
          <br />
          shows its work.
        </h2>
        <p className="lobby-sub">
          {tableCount} tables. Every seed sealed before you bet, every payout recomputed in your own
          browser, every settlement receipted on MsgBoard. A trust-me casino asks you to believe the
          odds — this room hands you the books.
        </p>
        <div className="lobby-meta-links">
          <button className="secondary" onClick={() => onPick('standings')}>
            🏆 Standings
          </button>
          <button className="secondary" onClick={() => onPick('live')}>
            🟢 The record
          </button>
        </div>
      </section>

      {receipts.length > 1 && (
        <div className="rail" aria-label="recent settlements">
          <div className="rail-track">
            {[0, 1].map((copy) => (
              <span className="rail-set" aria-hidden={copy === 1} key={copy}>
                {receipts.map((r, i) => (
                  <span className="rail-slip mono" key={`${copy}-${i}`}>
                    <span className="rail-game">{r.game}</span> {r.name.toLowerCase()} · block {r.block}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      )}

      {GROUPS.map((group) => {
        const list = grouped.get(group.key) ?? []
        if (!list.length) return null
        return (
          <section className="floor-section" key={group.key}>
            <h3 className="floor-title">
              {group.title} <span className="floor-blurb">{group.blurb}</span>
            </h3>
            <div className="tile-grid">
              {list.map((g) => {
                const { glyph, name } = splitLabel(g.label)
                const seal = SEAL[group.key]
                return (
                  <button className="tile" key={g.id} onClick={() => onPick(g.id)}>
                    <span className="tile-seal" title={seal.title} aria-label={seal.title}>
                      {seal.icon}
                    </span>
                    <span className="tile-glyph" aria-hidden>
                      {glyph}
                    </span>
                    <span className="tile-name">{name}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
