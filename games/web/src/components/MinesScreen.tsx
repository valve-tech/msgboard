import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  DEFAULT_TILES,
  multiplierX100At,
  type MinesConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useMinesSession, type MinesGameRecord } from '../hooks/useMinesSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n

const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** Tile-count options offered in the UI. DEFAULT_TILES (25, 5x5) is the reference grid. */
const TILE_OPTIONS = [9, 16, DEFAULT_TILES, 36] as const
/** Render the grid as a square when the tile count is a perfect square, else a sensible width. */
const gridCols = (tiles: number): number => {
  const root = Math.round(Math.sqrt(tiles))
  return root * root === tiles ? root : 5
}

/** A finished-game receipt in the DiceScreen style, with the provably-fair verify line. */
const GameReceipt = ({ record }: { record: MinesGameRecord }) => {
  const won = record.status === 'cashed'
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">game {record.id}</span>
          {viem.formatEther(record.stake)} staked
          {won ? (
            <span className="tag ok">cashed {fmtMult(record.multiplierX100)}</span>
          ) : (
            <span className="tag">busted 💣</span>
          )}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">
        {record.safeRevealed} safe of {record.config.tiles - record.config.mines} · {record.config.mines} mines · co-signed move log ({record.moves.length} moves)
      </p>
      <p className="card-meta muted">
        provably fair · board commit <span className="mono">{record.commit.slice(0, 10)}…</span> ·{' '}
        {record.verdict.ok ? (
          <span className="ok">verify ✓ (board re-checked)</span>
        ) : (
          <span className="bad">verify ✗ {record.verdict.reason}</span>
        )}
      </p>
      {record.timing && (
        <p className="card-meta muted">
          <TurnTiming timing={record.timing} />
        </p>
      )}
    </div>
  )
}

/**
 * Mines — the STATEFUL session game. Unlike the single-draw dice/limbo/plinko/keno screens (which
 * drive `useSession`/`HouseSession.playRound`), this one drives `useMinesSession`: a board is
 * committed up-front, the player clicks tiles to reveal them one at a time, and either cashes out
 * the running multiplier or busts on a mine. Component signature matches DiceScreen's exactly.
 */
export const MinesScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [tiles, setTiles] = useState<number>(DEFAULT_TILES)
  const [mines, setMines] = useState<number>(3)

  const session = useMinesSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const stake = parseStake(amount)
  const minesOk = Number.isInteger(mines) && mines >= 1 && mines <= tiles - 1
  const config: MinesConfig | undefined = minesOk ? { tiles, mines } : undefined

  // live "next reveal" multiplier preview for the configured board (before any reveal).
  const nextMultiplierX100 = useMemo(() => {
    if (!config) return undefined
    const safe = session.safeRevealed
    const totalSafe = config.tiles - config.mines
    return safe < totalSafe ? multiplierX100At(config, safe + 1) : undefined
  }, [config, session.safeRevealed])

  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && config !== undefined && !playing
  // current cash-out value = stake * runningMultiplier (the gross return on cash-out).
  const cashOutValue =
    stake !== undefined && session.safeRevealed > 0
      ? (stake * session.multiplierX100) / HUNDREDTHS
      : undefined

  const startGame = () => {
    if (stake === undefined || config === undefined) return
    session.newGame(config, stake)
  }

  // clamp mines into range whenever tiles changes.
  const onTiles = (t: number) => {
    setTiles(t)
    if (mines > t - 1) setMines(Math.max(1, t - 1))
  }

  const cashed = session.history.filter((g) => g.status === 'cashed').length
  const net = session.history.reduce((sum, g) => sum + g.playerDelta, 0n)
  const cols = gridCols(session.config?.tiles ?? tiles)

  return (
    <div>
      <div className="card">
        <h3>
          Mines
          <InfoDot>
            <strong>Clear safe tiles to grow your multiplier.</strong> Cash out any time — hit a mine
            and you bust. More mines means faster growth and bigger risk. The board is sealed before
            your first pick (it can't move under you), and you can re-check the whole game after.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            tiles
            <select
              value={tiles}
              onChange={(e) => onTiles(Number(e.target.value))}
              disabled={playing}
              style={{ width: '5rem' }}
              aria-label="tiles"
            >
              {TILE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="threshold-label">
            mines
            <input
              type="number"
              min={1}
              max={tiles - 1}
              step={1}
              value={mines}
              onChange={(e) => setMines(Number(e.target.value))}
              disabled={playing}
              style={{ width: '4.5rem' }}
              aria-label="mines"
            />
          </label>
          <button onClick={startGame} disabled={!canStart}>
            {playing ? 'Game in progress…' : 'New game'}
          </button>
          {playing && (
            <button onClick={() => session.cashOut()} disabled={!session.canCashOut}>
              Cash out {cashOutValue !== undefined ? `(${viem.formatEther(cashOutValue)})` : ''}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {!minesOk && <span className="bad">mines must be between 1 and {tiles - 1} · </span>}
          {playing && (
            <span className="ok">
              now {fmtMult(session.multiplierX100)}
              {nextMultiplierX100 !== undefined && (
                <span className="muted"> (next {fmtMult(nextMultiplierX100)})</span>
              )}
            </span>
          )}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            board commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {' · '}
            {session.safeRevealed} revealed · {fmtMult(session.multiplierX100)}
            {cashOutValue !== undefined && <> · cash-out value {viem.formatEther(cashOutValue)}</>}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}

        {/* the clickable tile grid */}
        {session.cells.length > 0 && (
          <div
            className="mines-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 2.4rem)`,
              gap: '0.4rem',
              marginTop: '0.75rem',
            }}
          >
            {session.cells.map((cell) => {
              const label = cell.revealed ? (cell.mine ? '💣' : '✓') : ''
              const cls = cell.revealed ? (cell.mine ? 'tag bad' : 'tag ok') : 'tag'
              return (
                <button
                  key={cell.tile}
                  type="button"
                  className={cls}
                  onClick={() => session.revealTile(cell.tile)}
                  disabled={!playing || cell.revealed}
                  style={{ width: '2.4rem', height: '2.4rem', padding: 0, fontSize: '1rem' }}
                  aria-label={`tile ${cell.tile}${cell.revealed ? (cell.mine ? ' mine' : ' safe') : ''}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* the just-finished game's receipt */}
      {session.lastGame && (
        <>
          <h2>Result</h2>
          <GameReceipt record={session.lastGame} />
        </>
      )}

      <h2>This table</h2>
      {session.status === 'idle' && session.history.length === 0 && (
        <p className="muted">No game yet — set your stake, board size, and mines, then start one.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <GameReceipt key={record.id} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} game{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {cashed}/{session.history.length} cashed · {viem.formatEther(net)} net
              </span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <GameReceipt key={record.id} record={record} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}
