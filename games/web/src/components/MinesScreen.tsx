import { Menu } from './Menu'
import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  DEFAULT_TILES,
  multiplierX100At,
  type MinesConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useMinesSession, type MinesGameRecord } from '../hooks/useMinesSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { RevealGrid, type RevealTile } from './stages/RevealGrid'

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
 *
 * View reshaped onto the shared table shell (GameStage/BetTray/MetaPanel), same as the other four
 * migrated games. The board itself renders via `RevealGrid` — the flat `.minesstage/.mgrid/.tile`
 * stage ported from game-configs.html's `#mines` panel — fed straight from `session.cells` (no new
 * tile model; `MinesCell.revealed`/`.mine` map 1:1 onto `RevealTile.state`).
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
  const [tileCount, setTileCount] = useState<number>(DEFAULT_TILES)
  const [mines, setMines] = useState<number>(3)

  const session = useMinesSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const stake = parseStake(amount)
  const minesOk = Number.isInteger(mines) && mines >= 1 && mines <= tileCount - 1
  const config: MinesConfig | undefined = minesOk ? { tiles: tileCount, mines } : undefined

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

  // clamp mines into range whenever the tile count changes.
  const onTileCount = (t: number) => {
    setTileCount(t)
    if (mines > t - 1) setMines(Math.max(1, t - 1))
  }

  const cashed = session.history.filter((g) => g.status === 'cashed').length
  const net = session.history.reduce((sum, g) => sum + g.playerDelta, 0n)
  const cols = gridCols(session.config?.tiles ?? tileCount)

  // MinesCell (revealed + mine) maps 1:1 onto RevealTile's hidden/gem/bomb — no new tile model.
  const gridTiles: RevealTile[] = session.cells.map((cell) => ({
    state: !cell.revealed ? 'hidden' : cell.mine ? 'bomb' : 'gem',
  }))

  const banner = playing && session.cells.length > 0 ? (
    <>
      next tile {nextMultiplierX100 !== undefined ? fmtMult(nextMultiplierX100) : '—'} · cash out {fmtMult(session.multiplierX100)}
    </>
  ) : undefined

  const onTile = (i: number) => {
    if (!playing) return
    session.revealTile(i)
  }

  return (
    <>
      <GameStage title="MINES" subtitle="flip gems, dodge the mines · sealed before you play">
        {gridTiles.length > 0 ? (
          <RevealGrid cols={cols} tiles={gridTiles} banner={banner} onTile={onTile} />
        ) : (
          <p className="muted">Set your stake, board size, and mines, then start a game.</p>
        )}
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            playing ? (
              <button className="primary amber" onClick={() => session.cashOut()} disabled={!session.canCashOut}>
                Cash out {cashOutValue !== undefined ? `(${viem.formatEther(cashOutValue)})` : ''}
              </button>
            ) : (
              <button className="primary" onClick={startGame} disabled={!canStart}>
                New game
              </button>
            )
          }
        >
          <label className="threshold-label">
            tiles
            <Menu
              label="tiles"
              options={TILE_OPTIONS.map(String)}
              value={Math.max(0, (TILE_OPTIONS as readonly number[]).indexOf(tileCount))}
              onChange={(i) => onTileCount(TILE_OPTIONS[i] as (typeof TILE_OPTIONS)[number])}
              disabled={playing}
            />
          </label>
          <div className="field">
            <label htmlFor="mines-count">Mines</label>
            <div className="box">
              <input
                id="mines-count"
                type="number"
                min={1}
                max={tileCount - 1}
                step={1}
                value={mines}
                onChange={(e) => setMines(Number(e.target.value))}
                disabled={playing}
                aria-label="mines"
                style={{ width: '100%', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit' }}
              />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>of {tileCount}</span>
            </div>
          </div>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && (
            <p className="tray-hint">tap "Got it" on the fairness note above first</p>
          )}
          <p className="muted">
            {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
            {!minesOk && <span className="bad">mines must be between 1 and {tileCount - 1} · </span>}
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
        </BetTray>

        <MetaPanel tabs={['Recent', 'Chart', 'Stats']}>
          {session.history.length > 0 ? (
            <span>
              <b>{cashed}</b>/{session.history.length} cashed · {viem.formatEther(net)} net
            </span>
          ) : session.status !== 'idle' || session.cells.length > 0 ? (
            <span>
              <b>{session.safeRevealed}</b> gems safe · {tileCount - session.safeRevealed} tiles left
            </span>
          ) : (
            <span className="muted">no games yet</span>
          )}
        </MetaPanel>
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
          <details className="history">
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
    </>
  )
}
