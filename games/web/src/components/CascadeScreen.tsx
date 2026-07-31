import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  cascade, resolveCascade, COLS, CELLS, SYMBOLS, MAX_MULT_X100, SYMBOL_BASE_X100,
  type CascadeParams,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { fmtMult } from './ladderShared'
import { TumbleGrid } from './stages/TumbleGrid'

const SYMBOL_EMOJI = ['🍒', '🍋', '🍇', '🔔', '⭐', '💎', '👑', '🎰'] as const // index 0..7, ascending pay
/** a neutral resting grid shown before the first spin — not a round, just something to look at. */
const IDLE_GRID = Array.from({ length: CELLS }, (_, i) => (i * 3 + Math.floor(i / COLS)) % SYMBOLS)

const RoundReceipt = ({ record }: { record: RoundRecord }) => {
  const { steps } = resolveCascade(record.raw)
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">round {record.round}</span>
          {viem.formatEther(record.stake)} staked
          {record.win ? <span className="tag ok">won {fmtMult(record.multiplierX100)}</span> : <span className="tag">lost</span>}
          <span className="muted"> · {steps.length} tumble{steps.length === 1 ? '' : 's'}</span>
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties</p>
      {record.timing && <p className="card-meta muted"><TurnTiming timing={record.timing} /></p>}
    </div>
  )
}

/**
 * OFF-CHAIN session-game screen (Cascade), on the shared TumbleGrid surface. One sealed seed fixes the
 * WHOLE tumble: matching symbols (8+ of a kind, scatter-pays) clear, survivors fall, fresh symbols drop
 * in, and it repeats until no match — the total multiplier is the sum of every tumble's pay, capped at
 * {MAX}. The grid the player watches is recomputed from the round's real `raw`, so the animation is the
 * exact sequence the co-signed multiplier was built from, not decoration.
 */
export const CascadeScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')

  const session = useSession<CascadeParams>({
    game: cascade,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'cascade',
  })

  const stake = parseStake(amount)
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canSpin = session.ready && !busy && stake !== undefined

  const spin = () => {
    if (stake === undefined) return
    void session.play(stake, {})
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const result = useMemo(() => (last ? resolveCascade(last.raw) : undefined), [last])
  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const spinLabel = session.status === 'playing' ? 'Tumbling…' : 'Spin'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="CASCADE" subtitle={`${COLS}×5 grid · scatter-pays at 8+`} action={<HowItWorksLink />}>
        <TumbleGrid
          cols={COLS}
          symbols={SYMBOL_EMOJI}
          steps={result ? result.steps : []}
          finalGrid={result ? result.finalGrid : IDLE_GRID}
          totalX100={result ? result.totalX100 : 0n}
          won={last?.win ?? false}
          tumbleId={session.history.length}
          idleHint="spin — 8+ of a symbol pays & clears, then the grid tumbles"
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={spin} disabled={!canSpin}>{spinLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            tumbles compound up to <b style={{ color: 'var(--gold-live)' }}>{fmtMult(MAX_MULT_X100)}</b>
            <span className="muted"> · {SYMBOLS} symbols, premiums pay more</span>
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && (
            <p className={last.win ? 'ok' : 'bad'}>
              {result ? `${result.steps.length} tumble${result.steps.length === 1 ? '' : 's'} · ` : ''}
              {fmtMult(last.multiplierX100)} · {last.playerDelta >= 0n ? '+' : ''}{viem.formatEther(last.playerDelta)}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Pays']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} won
              {session.commit && <span className="muted"> · commit {session.commit.slice(0, 10)}…</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — spin to tumble' : 'no spins yet'}</span>
          )}
          <div className="pay-row">
            {SYMBOL_EMOJI.map((e, i) => (
              <span key={i} className="pay-cell" title={`base ${fmtMult(SYMBOL_BASE_X100[i]!)} at 8+`}>
                {e} <b>{fmtMult(SYMBOL_BASE_X100[i]!)}</b>
              </span>
            ))}
          </div>
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} spin{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <RoundReceipt key={record.round} record={record} />)}
          </details>
        </>
      )}
    </>
  )
}
