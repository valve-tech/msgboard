import type { GameDeployment } from '../config'
import { useBoardFeed, type BoardNotice } from '../hooks/useBoardFeed'

const GAME_ICON: Record<string, string> = {
  dice: '🎲',
  limbo: '🚀',
  plinko: '🪙',
  keno: '🔢',
  mines: '💣',
  'hilo-ladder': '🔼',
  hilo: '⚔️',
}

const ago = (at?: number): string => {
  if (!at) return ''
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** `x${mult}` from a `multiplierX100` field (string/number/bigint), or '' if it isn't a finite number. */
const multX = (v: unknown): string => {
  const n = Number(v)
  return Number.isFinite(n) ? `x${(n / 100).toFixed(2)}` : ''
}

/**
 * A one-line human summary of a lifecycle notice.
 *
 * The bots (and player-driven sessions) post several field-disjoint payload shapes under the same
 * `kind: 'open' | 'summary'` envelope — a single-draw game, mines, a ladder climb, a decision
 * one-shot, the Hi-Lo War duel, and the Sudoku leaderboard all carry different extra fields (see
 * `BoardNotice` in useBoardFeed.ts). Dispatch on the CHARACTERISTIC FIELDS of each shape rather than
 * on `game` alone: game names are just labels chosen by whichever screen/bot posted the notice, and
 * two different games have collided on the same name before (the Hi-Lo ladder climb vs. the Hi-Lo War
 * duel both used to post as `'hilo'`). Every branch degrades to a generic, undefined-free line if a
 * field it expects turns out to be missing.
 */
export const describe = (n: BoardNotice): string => {
  if (n.kind === 'open') {
    if (typeof n.tiles === 'number' && typeof n.mines === 'number') {
      return `opened a ${n.tiles}-tile / ${n.mines}-mine board`
    }
    if ('escrowEach' in n && 'deck' in n) {
      return `sat down to a Hi-Lo War table${typeof n.escrowEach !== 'undefined' ? ` (escrow ${n.escrowEach})` : ''}`
    }
    if ('puzzle' in n) return `started a Sudoku puzzle${typeof n.puzzle === 'string' ? ` ${n.puzzle}` : ''}`
    if (typeof n.maxSteps === 'number') return `opened a climb (${n.maxSteps} steps max)`
    return `opened a table`
  }
  if (n.kind === 'summary') {
    // Hi-Lo War duel settlement: flips + both peers' balances.
    if (typeof n.flips !== 'undefined' && 'balA' in n && 'balB' in n) {
      return `settled after ${n.flips} flips (A ${n.balA} · B ${n.balB})`
    }
    // mines: reveal count + bust flag.
    if (typeof n.reveals !== 'undefined' && 'busted' in n) {
      const net = typeof n.delta !== 'undefined' ? ` (${n.delta} net)` : ''
      return `${n.busted ? 'hit a mine' : `cashed out ${n.reveals} safe`}${net}`
    }
    // ladder climb (towers/chicken/firewalk/heist/hilo-ladder/greedDice/cipher): step count + bust flag.
    if (typeof n.steps !== 'undefined' && 'busted' in n) {
      const parts = [multX(n.multiplierX100), typeof n.delta !== 'undefined' ? `${n.delta} net` : ''].filter(Boolean)
      const suffix = parts.length ? ` (${parts.join(', ')})` : ''
      return `${n.busted ? 'busted' : 'cashed out'} at step ${n.steps}${suffix}`
    }
    // decision one-shot (blackjack/threeCardPoker/videoPoker/paiGow/roulette/wordle): a settle detail.
    if (typeof n.detail === 'string') {
      const net = typeof n.delta !== 'undefined' ? ` (${n.delta} net)` : ''
      return `${n.detail}${net}`
    }
    // Sudoku leaderboard: elapsed time + rank, not a wager.
    if (typeof n.elapsed !== 'undefined') {
      return `solved in ${n.elapsed}s${typeof n.rank !== 'undefined' ? ` (rank ${n.rank})` : ''}`
    }
    // single-draw games (dice/limbo/plinko/keno/…): round count + running balance.
    if (typeof n.rounds !== 'undefined' && typeof n.balance !== 'undefined') {
      return `played ${n.rounds} rounds (balance ${n.balance})`
    }
    return 'settled'
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
