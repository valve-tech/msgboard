import { useState } from 'react'
import * as viem from 'viem'
import { dragonTiger, dealDragonTiger, type DragonTigerParams, type DragonTigerBet } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useSession, type RoundRecord } from '../hooks/useSession'
import { parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { Card, CardBack } from './decisionShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { FeltTable } from './stages/FeltTable'

const BETS: readonly DragonTigerBet[] = ['dragon', 'tiger', 'tie']
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

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
            <span className="tag">half back</span>
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

/** A single-card seat in the face-off — a big card (or face-down back) over a name caption that
 *  lights gold when this side won. */
const Seat = ({ card, label, won }: { card?: number; label: string; won?: boolean }) => (
  <div className="row" style={{ flexDirection: 'column', alignItems: 'center', gap: 8 }}>
    {card !== undefined ? <Card index={card} big /> : <CardBack big />}
    <span
      className={won ? 'ok' : 'muted'}
      style={{ letterSpacing: '0.18em', fontSize: 13, fontWeight: won ? 700 : 400 }}
    >
      {label}
    </span>
  </div>
)

/**
 * Dragon Tiger — the fastest card duel: one card to Dragon, one to Tiger, higher rank wins (ace low).
 * The two cards stand up side-by-side in the foreground as a face-off; the three bet circles
 * (Dragon / Tiger / Tie) line the rail. Both cards come off a deck shuffled from the sealed seed —
 * nothing dealer-chosen — and are recomputed from the round's revealed seed for display.
 */
export const DragonTigerScreen = ({
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
  const [bet, setBet] = useState<DragonTigerBet>('dragon')

  const session = useSession<DragonTigerParams>({
    game: dragonTiger,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'dragon-tiger',
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
  const coup = last ? dealDragonTiger(last.raw) : undefined

  const wins = session.history.filter((r) => r.win).length
  const net = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  const faceOff = (
    <div className="row" style={{ gap: 'clamp(16px, 4vw, 46px)', alignItems: 'center' }}>
      <Seat card={coup?.dragon} label="Dragon" won={coup?.winner === 'dragon'} />
      <span className="muted" style={{ fontFamily: 'var(--serif)', fontSize: 18, letterSpacing: '0.1em' }}>vs</span>
      <Seat card={coup?.tiger} label="Tiger" won={coup?.winner === 'tiger'} />
    </div>
  )
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
        {fmtMult(dragonTiger.maxMultiplierX100({ bet: b }))}
      </span>
    </button>
  ))

  const dealLabel = session.status === 'playing' ? 'Dealing…' : 'Deal'
  const openLabel = session.status === 'opening' ? 'Opening…' : 'Open table'

  return (
    <>
      <GameStage title="DRAGON TIGER" subtitle="higher card wins · ace low" action={<HowItWorksLink />}>
        <FeltTable player={faceOff} spots={spotsNode} centerMark={null} />
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
            betting <b style={{ color: 'var(--gold)' }}>{cap(bet)}</b> · pays {fmtMult(dragonTiger.maxMultiplierX100({ bet }))}
            {bet !== 'tie' && <span className="muted"> · tie returns half</span>}
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
          <details className="history" open>
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
