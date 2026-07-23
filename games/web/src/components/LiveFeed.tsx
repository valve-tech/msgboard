import type { GameDeployment } from '../config'
import { useBoardFeed, type BoardNotice } from '../hooks/useBoardFeed'

const GAME_ICON: Record<string, string> = {
  dice: '🎲',
  limbo: '🚀',
  plinko: '🪙',
  keno: '🔢',
  mines: '💣',
  hilo: '⚔️',
}

const ago = (at?: number): string => {
  if (!at) return ''
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** A one-line human summary of a lifecycle notice. */
const describe = (n: BoardNotice): string => {
  const g = n.game ?? 'game'
  if (n.kind === 'open') {
    if (g === 'mines') return `opened a ${n.tiles}-tile / ${n.mines}-mine board`
    if (g === 'hilo') return `sat down to a Hi-Lo War table (escrow ${n.escrowEach})`
    return `opened a table`
  }
  if (n.kind === 'summary') {
    if (g === 'mines') return `${n.busted ? 'hit a mine' : `cashed out ${n.reveals} safe`} (${n.delta} net)`
    if (g === 'hilo') return `settled after ${n.flips} flips (A ${n.balA} · B ${n.balB})`
    return `played ${n.rounds} rounds (balance ${n.balance})`
  }
  return n.kind ?? 'activity'
}

/**
 * The live, on-chain-board view of the house: every table the session bots (and, later, players)
 * open and settle posts a proof-of-work notice to one shared MsgBoard category, and this panel polls
 * it. It is the proof the games are really running on testnet — not a local simulation: the same
 * notices are visible to anyone polling the board (or the archive).
 */
export const LiveFeed = ({ deployment }: { deployment: GameDeployment }) => {
  const notices = useBoardFeed(deployment)

  if (!deployment.boardRpc) {
    return (
      <div className="card">
        <p className="muted">No MsgBoard endpoint configured for {deployment.label} — live feed unavailable.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="card">
        <h3>Live on the board</h3>
        <p className="muted">
          Tables opening and settling on <span className="mono">{deployment.label}</span>, read straight from the
          MsgBoard <span className="mono">games.msgboard.xyz:lobby:{deployment.chainId}</span> category — proof-of-work
          notices the house bots post as they play. The board is a live signal (recent activity only); refreshes every
          15s.
        </p>
      </div>
      {notices.length === 0 ? (
        <div className="card">
          <p className="muted">Waiting for the next table… (the bots post a notice each time one opens or settles).</p>
        </div>
      ) : (
        notices.map((n, i) => (
          <div className="card" key={`${n.tableId ?? i}:${n.at ?? i}:${n.kind ?? ''}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="tag">{GAME_ICON[n.game ?? ''] ?? '🎰'} {n.game ?? 'game'}</span>
                <span className={n.kind === 'open' ? 'tag' : 'tag ok'}>{n.kind ?? 'note'}</span>
                {describe(n)}
              </span>
              <span className="muted mono">{ago(n.at)}</span>
            </div>
            {typeof n.tableId === 'string' && (
              <p className="card-meta muted">
                table <span className="mono">{n.tableId.slice(0, 10)}…</span>
                {typeof n.commit === 'string' && (
                  <>
                    {' · '}commit <span className="mono">{n.commit.slice(0, 10)}…</span>
                  </>
                )}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  )
}
