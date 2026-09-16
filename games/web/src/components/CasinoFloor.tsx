import { useEffect, useState, type ReactNode } from 'react'
import type { GameDeployment } from '../config'

/**
 * CasinoFloor — the venue's entrance: a flat, ordinary-document-flow list of pits (organized by game
 * type) that you scroll down through like walking a hall. Every table is a felt puck stamped with the
 * trust seal of the model it rests on. No CSS 3D (no `perspective`, `preserve-3d`, or `rotateX/Y/Z`) is
 * used for layout — those constructs don't composite reliably in every browser (observed collapsing
 * into stacked full-viewport blocks in Safari), so the floor is built to render correctly with plain
 * 2D flexbox everywhere. Each pit's row of tables scrolls horizontally in its own container when it
 * doesn't fit, so the page itself never scrolls sideways.
 */

type TrustModel = 'validator' | 'p2p' | 'zk' | 'cosigned'
export type FloorGame = { id: string; label: string }

const SEAL: Record<TrustModel, { icon: string; title: string }> = {
  cosigned: { icon: '◈', title: 'Seed sealed before the first hand; your browser recomputes every payout' },
  p2p: { icon: '🤝', title: 'Peer vs peer — no house randomness at all' },
  zk: { icon: '🔮', title: 'Zero-knowledge proof — trust only the math' },
  validator: { icon: '⛓', title: 'Seed drawn from validator secrets locked on chain' },
}

/** The floor plan — pits in the order you walk past them, each holding a set of game ids. */
const PITS: { key: string; sign: string; blurb: string; ids: string[] }[] = [
  { key: 'cards', sign: 'The Card Room', blurb: 'seed sealed before the deal',
    ids: ['blackjack', 'baccarat', 'dragon-tiger', 'andar-bahar', 'three-card', 'pai-gow', 'video-poker', 'monte', 'hilo'] },
  { key: 'wheels', sign: 'Wheels & Dice', blurb: 'spun from the sealed seed',
    ids: ['roulette', 'wheel', 'dice', 'dicex2', 'craps', 'keno', 'greed-dice', 'lottery', 'raffle', 'tables'] },
  { key: 'crash', sign: 'Crash Lane', blurb: 'cash out before the bust',
    ids: ['crash', 'limbo', 'plinko', 'pachinko', 'cascade'] },
  { key: 'climb', sign: 'The Climb', blurb: 'press your luck, step by step',
    ids: ['mines', 'towers', 'chicken', 'firewalk', 'heist', 'cipher', 'hilo-ladder'] },
  { key: 'proof', sign: 'Duels & The Proof Parlor', blurb: 'peer vs peer · trust only the math',
    ids: ['coinflip', 'flipbookx', 'sudoku', 'wordle'] },
]

/** "🂡 Blackjack" -> { glyph:"🂡", name:"Blackjack" }. */
const splitLabel = (label: string) => {
  const i = label.indexOf(' ')
  return i > 0 ? { glyph: label.slice(0, i), name: label.slice(i + 1) } : { glyph: '🎲', name: label }
}

type Receipt = { game: string; name: string; block: string }
/** Recent terminal events off the games indexer — the overhead tote. Fails to empty. */
const useReceipts = (indexer: string | undefined, chainId: number): Receipt[] => {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  useEffect(() => {
    if (!indexer) return
    let stop = false
    const load = async () => {
      try {
        const res = await fetch(indexer, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `query($chainId: Int!) { gameEvents(where: { chainId: $chainId }, orderBy: "blockNumber", orderDirection: "desc", limit: 14) { items { game name blockNumber } } }`,
            variables: { chainId },
          }),
        })
        const json = (await res.json()) as { data?: { gameEvents?: { items?: { game: string; name: string; blockNumber: string }[] } } }
        const items = json.data?.gameEvents?.items ?? []
        if (!stop) setReceipts(items.map((e) => ({ game: e.game, name: e.name, block: e.blockNumber })))
      } catch { /* the tote simply stays empty */ }
    }
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => { stop = true; clearInterval(t) }
  }, [indexer, chainId])
  return receipts
}

const Puck = ({ game, seal, onPick }: { game: FloorGame; seal: { icon: string; title: string }; onPick: (id: string) => void }) => {
  const { glyph, name } = splitLabel(game.label)
  return (
    <button className="cf-table" onClick={() => onPick(game.id)}>
      <span className="cf-puck">
        <span className="cf-seal" title={seal.title} aria-hidden>{seal.icon}</span>
        <span className="cf-glyph" aria-hidden>{glyph}</span>
      </span>
      <span className="cf-plate">{name}</span>
    </button>
  )
}

const Pit = ({ pitIndex, games, trustFor, onPick }: {
  pitIndex: number
  games: Map<string, FloorGame>; trustFor: (id: string) => TrustModel | null; onPick: (id: string) => void
}) => {
  const pit = PITS[pitIndex]!
  const list = pit.ids.map((id) => games.get(id)).filter((g): g is FloorGame => !!g)
  if (!list.length) return null
  return (
    <section className="cf-pit">
      <div className="cf-sign"><span className="cf-lamp" />{pit.sign}</div>
      <div className="cf-blurb">{pit.blurb}</div>
      <div className="cf-tables">
        {list.map((g) => {
          const model = trustFor(g.id) ?? 'cosigned'
          return <Puck key={g.id} game={g} seal={SEAL[model]} onPick={onPick} />
        })}
      </div>
    </section>
  )
}

export const CasinoFloor = ({ deployment, games, trustFor, onPick, topRight }: {
  deployment: GameDeployment
  games: FloorGame[]
  trustFor: (id: string) => TrustModel | null
  onPick: (id: string) => void
  topRight: ReactNode
}) => {
  const byId = new Map(games.map((g) => [g.id, g]))
  const receipts = useReceipts(deployment.gamesIndexer, deployment.chainId)
  const tableCount = games.filter((g) => PITS.some((p) => p.ids.includes(g.id))).length

  return (
    <div className="cf-root">
      <div className="cf-marquee">
        <div className="cf-brand">M</div>
        <div className="cf-word">THE <b>◈</b> HOUSE</div>
        <div className="cf-tagline">{tableCount} tables · every one verifiable · no account, just a wallet</div>
        <div className="cf-controls">{topRight}</div>
      </div>

      {receipts.length > 1 && (
        <div className="cf-ticker" aria-label="recent settlements">
          <div className="cf-ticker-track">
            {[0, 1].map((copy) => (
              <span className="cf-ticker-set" aria-hidden={copy === 1} key={copy}>
                {receipts.map((r, i) => (
                  <span className="cf-slip" key={`${copy}-${i}`}><b>{r.game}</b> {r.name.toLowerCase()} · block {r.block}</span>
                ))}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="cf-hall">
        {PITS.map((_, i) => (
          <Pit key={i} pitIndex={i} games={byId} trustFor={trustFor} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}
