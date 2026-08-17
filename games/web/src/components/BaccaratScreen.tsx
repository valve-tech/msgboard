import { useState } from 'react'
import * as viem from 'viem'
import { baccarat, dealBaccarat, type BaccaratParams, type BaccaratBet } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const BETS: readonly BaccaratBet[] = ['player', 'banker', 'tie']
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Card games can PUSH (delta 0, not a win) — show that distinctly from a loss. */
const RoundReceipt = ({ record }: { record: RoundRecord }) => {
  const push = !record.win && record.playerDelta === 0n
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">round {record.round}</span>
          {viem.formatEther(record.stake)} staked
          {record.win ? (
            <span className="tag ok">won {fmtMult(record.multiplierX100)}</span>
          ) : push ? (
            <span className="tag">push</span>
          ) : (
            <span className="tag">lost</span>
          )}
        </span>
        <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
          {record.playerDelta >= 0n ? '+' : ''}
          {viem.formatEther(record.playerDelta)}
        </span>
      </div>
      <p className="card-meta muted">
        balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties
      </p>
      {record.timing && (
        <p className="card-meta muted">
          <TurnTiming timing={record.timing} />
        </p>
      )}
    </div>
  )
}

/** A labelled hand on the felt — cards over a name·total caption. Face-down backs before the deal. */
const Hand = ({ cards, total, label, big }: { cards?: number[]; total?: number; label: string; big?: boolean }) => (
  <div className="row" style={{ flexDirection: 'column', alignItems: 'center', gap: big ? 8 : 6 }}>
    <div className="row" style={{ gap: big ? 10 : 6 }}>
      {cards ? cards.map((c, i) => <Card key={i} index={c} big={big} />) : <><CardBack big={big} /><CardBack big={big} /></>}
    </div>
    <span className="muted" style={{ letterSpacing: '0.12em', fontSize: big ? 12 : 10 }}>
      {label}{total !== undefined ? ` · ${total}` : ''}
    </span>
  </div>
)

/**
 * Baccarat — punto banco. Bet Player, Banker, or Tie; both hands are dealt by the fixed third-card
 * rules from the sealed shoe (no choices to steer). On the felt the Banker hand sits at the far end,
 * the Player hand stands up close, and the three bet circles line the front rail. Split co-sign
 * session (open a table, then deal); the dealt cards are recomputed from the round's revealed seed.
 */
export const BaccaratScreen = ({
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
  const [bet, setBet] = useState<BaccaratBet>('player')

  const session = useSession<BaccaratParams>({
    game: baccarat,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'baccarat',
  })

  const stake = parseStake(amount)
  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canDeal = session.ready && !busy && stake !== undefined

  const deal = () => {
    if (stake === undefined) return
    void session.play(stake, { bet })
  }

  const last = session.history.length > 0 ? session.history[session.history.length - 1] : undefined
  const coup = last ? dealBaccarat(last.raw) : undefined

  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const bankerNode = <Hand label="Banker" cards={coup?.bankerCards} total={coup?.bankerTotal} />
  const playerNode = <Hand label="Player" cards={coup?.playerCards} total={coup?.playerTotal} big />
  const spotsNode = BETS.map((b) => (
    <button
      key={b}
      type="button"
      className={`spot${bet === b ? ' main' : ''}`}
      onClick={() => setBet(b)}
      aria-label={`bet ${b}`}
      style={coup && coup.winner === b ? { outline: '2px solid var(--gold-live)', outlineOffset: 3 } : undefined}
    >
      {cap(b)}
      <span style={{ display: 'block', fontSize: 9, opacity: 0.75, fontWeight: 400 }}>
        {fmtMult(baccarat.maxMultiplierX100({ bet: b }))}
      </span>
    </button>
  ))

  const dealLabel = session.status === 'playing' ? 'Dealing…' : 'Deal'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="BACCARAT" subtitle="punto banco · sealed shoe">
        <FeltTable
          dealer={bankerNode}
          player={playerNode}
          spots={spotsNode}
          centerMark={null}
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            session.ready ? (
              <button className="primary" onClick={deal} disabled={!canDeal}>{dealLabel}</button>
            ) : (
              <button className="primary" onClick={() => void session.start()} disabled={!canOpen}>{openLabel}</button>
            )
          }
        >
          <p className="tray-hint">
            betting <b style={{ color: 'var(--gold)' }}>{cap(bet)}</b> · pays {fmtMult(baccarat.maxMultiplierX100({ bet }))}
            {bet !== 'tie' && <span className="muted"> · ties push</span>}
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {last && coup && (
            <p className={last.win ? 'ok' : last.playerDelta === 0n ? '' : 'bad'}>
              {coup.winner === 'tie' ? 'Tie' : `${cap(coup.winner)} wins`} ·{' '}
              {last.win ? `+${viem.formatEther(last.playerDelta)}` : last.playerDelta === 0n ? 'push' : viem.formatEther(last.playerDelta)}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span>
              <b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {wins}/{session.history.length} won
              {session.commit && <span className="muted"> · commit {session.commit.slice(0, 10)}…</span>}
            </span>
          ) : (
            <span className="muted">{session.ready ? 'table open — set your bet and deal' : 'no hands yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>
              {session.history.length} hand{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {wins}/{session.history.length} won · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </>
  )
}
